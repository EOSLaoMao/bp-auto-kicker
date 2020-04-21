const config = require('./config')
const fetch = require('node-fetch');
const util = require('util');
const { Api, JsonRpc, RpcError } = require('eosjs');
const { JsSignatureProvider } = require('eosjs/dist/eosjs-jssig');
const { TextEncoder, TextDecoder } = require('util'); // native TextEncoder/Decoder
const { IncomingWebhook } = require('@slack/webhook');

const signatureProvider = new JsSignatureProvider([config.PROPOSER_PRIVATE_KEY]);
const rpc = new JsonRpc(config.RPC_HOST, { fetch });
const api = new Api({ rpc, signatureProvider, textDecoder: new TextDecoder(), textEncoder: new TextEncoder() });
const webhook = new IncomingWebhook(config.SLACK_WEBHOOK_URL);

// Notify via slack
function notify_slack(msg) {
  console.log(msg);
  if(config.ENABLE_SLACK) {
    // Send the notification via slack
    (async () => {
      await webhook.send({
        text: msg
      });
    })();
  }
}

// Check proposals from Aloha Tracker
function monitor(){
  const now = Date();
  (async () => {
    let resp = await rpc.get_table_rows({
      json: true,                                 // Get the response as json
      code: 'eosio.msig',                         // Contract that we target
      scope: config.ALOHA_TRACKER_ACCOUNT,        // Account that owns the data
      table: 'proposal',                          // Table name
      limit: 10,                                  // Maximum number of rows that we want to get
      reverse: false                              // False, means newest appear first
    });
    let kicking_proposals = resp.rows;

    //get proposed kicking proposals
    resp = await rpc.get_table_rows({
      json: true,                     // Get the response as json
      code: 'eosio.msig',             // Contract that we target
      scope: config.PROPOSER_ACCOUNT, // Account that owns the data
      table: 'proposal',              // Table name
      limit: 10,                      // Maximum number of rows that we want to get
      reverse: false                  // False, means newest appear first
    });
    let proposed_proposals = resp.rows;

    if(kicking_proposals.length == 0) {
      if(proposed_proposals.length > 0) {
        //cancel proposed proposals
        proposed_proposals.forEach(function(p){
          cancel_proposal(p);
        });
      }
    } else {
      // Only process the first kicking proposal
      let kicking_proposal = kicking_proposals[0];
      let msg = util.format('Found kicking proposal: %s. Time: %s', kicking_proposal.proposal_name, now);
      notify_slack(msg);
      proposed_proposals.forEach(function(value){
        if(value.proposal_name == kicking_proposal.proposal_name) {
          let msg = util.format('Kicking proposal already proposed, please review ASAP: https://bloks.io/msig/%s/%s Time: %s', config.PROPOSER_ACCOUNT, kicking_proposal.proposal_name, now);
          notify_slack(msg);
          proposal_needed = false;
        }
      });
      if(proposal_needed) {
        console.log("Prepare to approve kicking proposal:", kicking_proposal.proposal_name);
        //Step2: propose to approve this new proposal
        propose(kicking_proposal)
      }
    }
  })();
  setTimeout(monitor, 1000 * 60);
}

function cancel_proposal(proposal){
  const now = Date();
  (async () => {
    //cancel proposal
    const transaction = await api.transact({
      actions: [{
        account: 'eosio.msig',
        name: 'cancel',
        authorization: [{
          actor: config.PROPOSER_ACCOUNT,
          permission: 'active',
        }],
        data: {
          proposer: config.PROPOSER_ACCOUNT,
          proposal_name: proposal.proposal_name,
          canceler: config.PROPOSER_ACCOUNT
        },
      }]
    }, {
      blocksbehind: 3,
      expireseconds: 30 * 60, // 30 minutes to expire
    });

    let msg = util.format('Canceled proposal %d: https://bloks.io/transaction/%s time: %s', proposal.proposal_name, transaction.transaction_id, now);
    notify_slack(msg)
  })();
}

//function to propose to approve kicking proposal
function propose(kicking_proposal){
  const now = Date();
  (async () => {
    //step1: generate approval transaction payload
    const result = await api.transact({
      actions: [{
        account: 'eosio.msig',
        name: 'approve',
        authorization: [{
          actor: config.bp_account,
          permission: 'active',
        }],
        data: {
          proposer: config.aloha_tracker_account,
          proposal_name: kicking_proposal.proposal_name,
          level: {
            "actor": config.bp_account,
            "permission": "active"
          }
        },
      }]
    }, {
      blocksbehind: 3,
      expireseconds: 30 * 60, // 30 minutes to expire
      broadcast: false,
      sign: false
    });

    //step2: deserialize transaction back to json
    const tx = await api.deserializetransactionwithactions(result.serializedtransaction);
    const data = await api.serializeactions(tx.actions)
    tx.actions[0].data = data[0].data;

    //step3: send approval transaction as payload of another proposal
    const proposal = await api.transact({
      actions: [{
        account: 'eosio.msig',
        name: 'propose',
        authorization: [{
          actor: config.PROPOSER_ACCOUNT,
          permission: 'active',
        }],
        data: {
          proposer: config.PROPOSER_ACCOUNT,
          proposal_name: kicking_proposal.proposal_name,
          requested: config.bp_permission,
          trx: tx
        },
      }]
    }, {
      blocksbehind: 3,
      expireseconds: 30 * 60, // 30 minutes to expire
    });

    /*
    proposal = {
      transaction_id: 'd93111537dc771f34ec866eba40daaaee6b92e69af5351ccf3151bb6f4437c10',
      processed: {
        id:'d93111537dc771f34ec866eba40daaaee6b92e69af5351ccf3151bb6f4437c10',
        block_num: 115456895,
        block_time: '2020-04-14t12:07:04.500',
        producer_block_id: null,
        receipt: {
          status: 'executed',
          cpu_usage_us: 877,
          net_usage_words: 34
        },
        elapsed: 877,
        net_usage: 272,
        scheduled: false,
        action_traces: [],
        account_ram_delta: null,
        except: null,
        error_code: null
      }
    }
    */
    let msg = util.format('proposed a proposal to remove block producer, please review: https://bloks.io/transaction/%s time: %s', proposal.transaction_id, now);
    notify_slack(msg)
  })();
}

monitor();
