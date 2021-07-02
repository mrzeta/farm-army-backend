const request = require("async-request");
const fs = require("fs");
const path = require("path");

const { MultiCall } = require("eth-multicall");
const Web3 = require("web3");
const _ = require("lodash");
const crypto = require("crypto");

const { ethers } = require("ethers");
const { providers } = require("ethers");
const fetch = require("node-fetch");
const AbortController = require("abort-controller");
const { MulticallProvider } = require("@0xsequence/multicall").providers;

const MULTI_CALL_CONTRACT = {
  bsc: '0xB94858b0bB5437498F5453A16039337e5Fdc269C',
  polygon: '0x13E5407E38860A743E025A8834934BEA0264A8c1',
}

const HOSTS = Object.freeze([
  // Recommend
  'https://bsc-dataseed.binance.org/',
  'https://bsc-dataseed1.defibit.io/',
  'https://bsc-dataseed1.ninicoin.io/',

  // Backup
  'https://bsc-dataseed2.defibit.io/',
  'https://bsc-dataseed3.defibit.io/',
  'https://bsc-dataseed4.defibit.io/',
  'https://bsc-dataseed2.ninicoin.io/',
  'https://bsc-dataseed3.ninicoin.io/',
  'https://bsc-dataseed4.ninicoin.io/',
  'https://bsc-dataseed1.binance.org/',
  'https://bsc-dataseed2.binance.org/',
  'https://bsc-dataseed3.binance.org/',
  'https://bsc-dataseed4.binance.org/',
]);

const HOSTS_POLYGON = Object.freeze([
  // Recommend
  'https://rpc-mainnet.matic.network',
  'https://rpc-mainnet.maticvigil.com',
  'https://rpc-mainnet.matic.quiknode.pro',
  'https://matic-mainnet.chainstacklabs.com',
  'https://matic-mainnet-full-rpc.bwarelabs.com',
]);

const ENDPOINTS_MULTICALL = {};
const ENDPOINTS_RPC_WRAPPER = {};

HOSTS.forEach(url => {
  ENDPOINTS_MULTICALL[url] = new MulticallProvider(
    new providers.StaticJsonRpcProvider({
      url: url,
      timeout: 10000,
    }),
    {
      contract: MULTI_CALL_CONTRACT.bsc,
      batchSize: 50,
      timeWindow: 50,
    }
  )

  const f1 = new Web3.providers.HttpProvider(url, {
      keepAlive: true,
      timeout: 10000,
    }
  )

  ENDPOINTS_RPC_WRAPPER[url] = new Web3(f1)
});

const ENDPOINTS = Object.freeze(Object.keys(ENDPOINTS_MULTICALL));

const ENDPOINTS_MULTICALL_POLYGON = {};
const ENDPOINTS_RPC_WRAPPER_POLYGON = {};

HOSTS_POLYGON.forEach(url => {
  ENDPOINTS_MULTICALL_POLYGON[url] = new MulticallProvider(
    new providers.StaticJsonRpcProvider({
      url: url,
      timeout: 10000,
    }),
    {
      contract: MULTI_CALL_CONTRACT.polygon,
      batchSize: 50,
      timeWindow: 50,
    }
  )

  const f1 = new Web3.providers.HttpProvider(url, {
      keepAlive: true,
      timeout: 10000,
    }
  )

  ENDPOINTS_RPC_WRAPPER_POLYGON[url] = new Web3(f1)
});

const ENDPOINTS_POLYGON = Object.freeze(Object.keys(ENDPOINTS_MULTICALL_POLYGON));

module.exports = {
  PRICES: {},
  BITQUERY_TRANSACTIONS: fs.readFileSync(
    path.resolve(__dirname, "bitquery/transactions.txt"),
    "utf8"
  ),
  erc20ABI: JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "platforms/pancake/abi/erc20.json"), "utf8")
  ),

  // @TODO: move it to somewhere else
  CONFIG: _.merge(
      JSON.parse(fs.readFileSync(path.resolve(__dirname, "../config.json"), "utf8")),
      fs.existsSync(path.resolve(__dirname, "../config.json.local")) ? JSON.parse(fs.readFileSync(path.resolve(__dirname, "../config.json.local"), "utf8")) : {}
  ),

  DUST_FILTER: 0.00000000001 * 1e18,


  getWeb3: () => {
    return ENDPOINTS_RPC_WRAPPER[_.shuffle(Object.keys(ENDPOINTS_RPC_WRAPPER))[0]];
  },

  multiCall: async (vaultCalls, chain = 'bsc') => {
    if (vaultCalls.length === 0) {
      return [];
    }

    const promises = [];
    const endpoints = _.shuffle(chain === 'polygon' ? ENDPOINTS_POLYGON.slice() : ENDPOINTS.slice());

    let i = 0;

    const hash = crypto
      .createHash("md5")
      .update(new Date().getTime().toString())
      .digest("hex");

    for (const chunk of _.chunk(vaultCalls, 80)) {
      const endpoint = endpoints[i];

      promises.push(async () => {
        let endpointInner = endpoint;

        let existing = endpoints.slice();

        const done = [];

        let throwIt;
        for (let i = 0; i < 2; i++) {
          if (i > 0) {
            existing = _.shuffle(
              existing.slice().filter(item => item !== endpointInner)
            );
            if (existing.length === 0) {
              console.log("no one left", hash);
              break;
            }

            endpointInner = existing[0];
          }

          try {
            done.push(endpointInner);

            const [foo] = await new MultiCall(
              chain === 'polygon' ? ENDPOINTS_RPC_WRAPPER_POLYGON[endpointInner] : ENDPOINTS_RPC_WRAPPER[endpointInner],
              MULTI_CALL_CONTRACT[chain]
            ).all([chunk]);
            return foo;
          } catch (e) {
            console.error("failed", "multiCall", endpointInner, chunk.length, e.message);
            throwIt = e;
          }
        }

        throw new Error(
          `final error: ${hash} ${endpointInner} ${
            chunk.length
          } ${JSON.stringify(done)} ${throwIt.message.substring(0, 100)}`
        );
      });
    }

    return (await Promise.all(promises.map(fn => fn()))).flat(1);
  },

  multiCallIndexBy: async (index, vaultCalls, chain = 'bsc') => {
    const proms = await module.exports.multiCall(vaultCalls, chain);

    const results = {};

    proms.forEach(c => {
      if (c[index]) {
        results[c[index]] = c;
      }
    });

    return results;
  },

  multiCallRpcIndex: async (calls, chain = 'bsc') => {
    const try1 =  await module.exports.multiCallRpcIndexInner(calls, chain);

    if (try1 === false) {
      console.error('multiCallRpcIndex retry');
      const try2 = await module.exports.multiCallRpcIndexInner(calls, chain);

      if (try2 === false) {
        console.error('multiCallRpcIndex final failed');
        return []
      }

      return try2
    }

    return try1;
  },

  multiCallRpcIndexInner: async (calls, chain = 'bsc') => {
    const endpoints = _.shuffle(chain === 'polygon' ? ENDPOINTS_POLYGON.slice() : ENDPOINTS.slice());

    const promises = [];

    calls.forEach(group => {
      const contract = new ethers.Contract(
        group.contractAddress,
        group.abi,
        chain === 'polygon' ? ENDPOINTS_MULTICALL_POLYGON[endpoints[0]] : ENDPOINTS_MULTICALL[endpoints[0]]
      );

      group.calls.forEach(call => {
        promises.push(
          contract[call.method](...call.parameters).then(r => {
            const reference = call.reference ? call.reference : call.method;

            return {
              reference: group.reference,
              call: [reference, r]
            };
          })
        );
      });
    });

    let results
    try {
      results = await Promise.all([...promises]);
    } catch (e) {
      console.error('failed', 'multiCallRpcIndex', e.message);
      if (e.message && e.message.includes('property \'toHexString\' of undefined')) {
        return false;
      }

      return [];
    }

    // pcIndex Cannot read property 'toHexString' of undefined

    const final = {};
    results.forEach(call => {
      if (!final[call.reference]) {
        final[call.reference] = {
          id: call.reference
        };
      }

      final[call.reference][call.call[0]] = call.call[1];
    });

    return final;
  },

  multiCallRpc: async calls => {
    return Object.values(await module.exports.multiCallRpcIndex(calls));
  },

  findYieldForDetails: result => {
    const percent = module.exports.findYieldForDetailsInner(result);

    if (
      percent &&
      percent.percent !== undefined &&
      Math.abs(percent.percent) <= 0
    ) {
      return undefined;
    }

    return percent;
  },

  findYieldForDetailsInner: result => {
    if (
      result.transactions &&
      result.transactions.length > 0 &&
      result.farm &&
      result.farm.deposit &&
      result.farm.deposit.amount
    ) {
      // no withdraw fine
      if (!result.transactions.find(t => t.amount < 0.0)) {
        return module.exports.findYieldForDepositOnly(
          result.farm.deposit.amount,
          result.transactions
        );
      }

      // filter by reset on withdraw below zero
      const filteredTransactions = module.exports.filterNegativeWithdrawResetTransaction(
        result.transactions
      );
      if (
        !filteredTransactions.find(t => t.amount < 0.0) &&
        filteredTransactions.length > 0
      ) {
        return module.exports.findYieldForDepositOnly(
          result.farm.deposit.amount,
          filteredTransactions
        );
      }

      if (filteredTransactions.length > 0) {
        return module.exports.findYieldForMixedTransactions(
          result.farm.deposit.amount,
          filteredTransactions
        );
      }
    }

    return undefined;
  },

  findYieldForDepositOnly: (deposits, transactions) => {
    const transactionDeposit = transactions
      .map(t => t.amount)
      .reduce((a, b) => a + b);

    const yieldAmount = deposits - transactionDeposit;

    return {
      amount: yieldAmount,
      percent: parseFloat(((yieldAmount / deposits) * 100).toFixed(3))
    };
  },

  getTransactionsViaBsc: async (contract, lpAddress, address) => {
    const url =
      "https://api.bscscan.com/api?module=account&action=tokentx&contractaddress=%contractaddress%&address=%address%&page=1&sort=asc&apikey=%apikey%";

    const myUrl = url
        .replace("%contractaddress%", lpAddress)
        .replace("%address%", address)
        .replace("%apikey%", module.exports.CONFIG['BSCSCAN_API_KEY']);

    let response = {};
    try {
      const responseBody = await request(myUrl);
      response = JSON.parse(responseBody.body);
    } catch (e) {
      console.error(myUrl, e.message);
      return [];
    }

    if (!response.result) {
      return [];
    }

    const transactions = response.result
      .filter(
        t =>
          t.value &&
          t.value > 0 &&
          t.tokenDecimal &&
          (t.to.toLowerCase() === contract.toLowerCase() ||
            t.from.toLowerCase() === contract.toLowerCase())
      )
      .map(t => {
        let amount = t.value / 10 ** t.tokenDecimal;

        if (t.from.toLowerCase() === contract.toLowerCase()) {
          amount = -amount;
        }

        return {
          timestamp: parseInt(t.timeStamp),
          amount: amount,
          hash: t.hash,
        };
      });

    return transactions.sort(function(a, b) {
      return b.timestamp - a.timestamp;
    });
  },

  getTransactions: async (contract, lpAddress, address) => {
    try {
      return await module.exports.getTransactionsViaBsc(
        contract,
        lpAddress,
        address
      );
    } catch (e) {
      console.log("transactions failed bsc", e.message);
    }

    try {
      return await module.exports.getTransactionsViaBitquery(
        contract,
        lpAddress,
        address
      );
    } catch (e) {
      console.log("transactions retry via bitquery", e.message);
    }

    try {
      return await module.exports.getTransactionsViaBitquery(
        contract,
        lpAddress,
        address
      );
    } catch (e) {
      console.log("transactions retry via bitquery failed also", e.message);
    }

    return [];
  },

  getTransactionsViaBitquery: async (contract, lpAddress, address) => {
    const query = module.exports.BITQUERY_TRANSACTIONS.replace(
      "%address%",
      address
    )
      .replace("%contract%", contract)
      .replace("%lp_address%", lpAddress)
      .replace("%address%", address)
      .replace("%contract%", contract)
      .replace("%lp_address%", lpAddress);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 11000);

    const opts = {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query
      }),
      signal: controller.signal
    };

    const foo = await fetch("https://graphql.bitquery.io/", opts);
    const data = await foo.json();

    const transactions = [];

    data.data.ethereum.in.forEach(item => {
      transactions.push({
        timestamp: item.block.timestamp.unixtime,
        amount: item.amount,
        hash: item.transaction.hash,
      });
    });

    data.data.ethereum.out.forEach(item => {
      transactions.push({
        timestamp: item.block.timestamp.unixtime,
        amount: -item.amount,
        hash: item.transaction.hash,
      });
    });

    return transactions.sort(function(a, b) {
      return b.timestamp - a.timestamp;
    });
  },

  filterNegativeWithdrawResetTransaction: transactions => {
    const reverse = transactions.slice().reverse();

    let balance = 0;
    let items = [];

    reverse.forEach(t => {
      if (t.amount > 0) {
        items.push(t);
        balance += t.amount;
      }

      if (t.amount < 0) {
        if (balance - Math.abs(t.amount) < 0) {
          balance = 0;
          items = [];
        } else {
          balance -= Math.abs(t.amount);
          items.push(t);
        }
      }
    });

    return items.reverse();
  },

  findYieldForMixedTransactions: (depositAmount, transactions) => {
    let deposit = 0;
    let withdraw = 0;

    transactions.forEach(t => {
      if (t.amount < 0) {
        withdraw += Math.abs(t.amount);
      } else {
        deposit += t.amount;
      }
    });

    const yieldAmount = depositAmount - (deposit - withdraw);

    return {
      amount: yieldAmount,
      percent: parseFloat(((yieldAmount / depositAmount) * 100).toFixed(3))
    };
  },

  /**
   * Also used sometimes
   */
  compoundCommon: (r) => {
    return module.exports.compound(r, 2190, 1, 0.955);
  },

  compound: (r, n = 365, t = 1, c = 1) => {
    return (1 + (r * c) / n) ** (n * t) - 1;
  },

  requestJsonGet: async (url, timeout = 10) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), timeout * 1000);

    const opts = {
      method: "GET",
      signal: controller.signal
    };

    try {
      const foo = await fetch(url, opts);
      return await foo.json();
    } catch (e) {
      console.error('error: ', url, e)
    }

    return undefined;
  },

  requestGet: async (url, timeout = 10) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), timeout * 1000);

    const opts = {
      method: "GET",
      signal: controller.signal
    };

    try {
      const foo = await fetch(url, opts);
      return await foo.text();
    } catch (e) {
      console.error('error: ', url, e)
    }

    return undefined;
  }
};
