const config = require('./config')
const fetch = require('node-fetch');
const util = require('util');
const Sentry = require('@sentry/node');
const { Api, JsonRpc, RpcError } = require('eosjs');
const { JsSignatureProvider } = require('eosjs/dist/eosjs-jssig');
const { TextEncoder, TextDecoder } = require('util'); // native TextEncoder/Decoder
const { IncomingWebhook } = require('@slack/webhook');

const signatureProvider = new JsSignatureProvider([config.PROPOSER_PRIVATE_KEY]);
const rpc = new JsonRpc(config.RPC_HOST, { fetch });
const api = new Api({ rpc, signatureProvider, textDecoder: new TextDecoder(), textEncoder: new TextEncoder() });

console.log("config:", config);

if(config.SENTRY_DSN) {
  Sentry.init({ dsn: config.SENTRY_DSN });
}

//validate BP permission first
function fetch_bp_permission() {
  (async () => {
    let resp = await rpc.get_account(config.BP_ACCOUNT);
    let bp_permission = [];
    resp.permissions.forEach(function(value) {
      if(value.perm_name == config.BP_PERMISSION_NAME) {
        value.required_auth.accounts.forEach(function(account){
          bp_permission.push(account.permission);
        });
        config.BP_PERMISSION = bp_permission;
      } else {
        //process.exit("no active permission found! abort!");
      }
    });
  })();
}

// Notify via slack
function notify_slack(msg) {
  console.log(msg);
  let webhook = new IncomingWebhook(config.SLACK_WEBHOOK_URL);
  // Send the notification via slack
  (async () => {
    await webhook.send({
      text: msg
    });
  })();
}

function cancel_proposal(proposal){
  const now = Date();
  (async () => {
    // Cancel proposal
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
      blocksBehind: 3,
      expireSeconds: 30 * 60, // 30 minutes to expire
    });

    let msg = util.format('Canceled outdated proposal %s: https://bloks.io/transaction/%s time: %s', proposal.proposal_name, transaction.transaction_id, now);
    notify_slack(msg);
  })();
}

//function to propose to approve kicking proposal
function propose(kicking_proposal){
  const now = Date();
  (async () => {
    //Step1: generate approval transaction payload
    const result = await api.transact({
      actions: [{
        account: 'eosio.msig',
        name: 'approve',
        authorization: [{
          actor: config.BP_ACCOUNT,
          permission: 'active',
        }],
        data: {
          proposer: config.ALOHA_TRACKER_ACCOUNT,
          proposal_name: kicking_proposal.proposal_name,
          level: {
            "actor": config.BP_ACCOUNT,
            "permission": "active"
          }
        },
      }]
    }, {
      blocksBehind: 3,
      expireSeconds: 30 * 60, // 30 minutes to expire
      broadcast: false,
      sign: false
    });

    //Step2: deserialize transaction back to JSON
    const tx = await api.deserializeTransactionWithActions(result.serializedTransaction);
    const data = await api.serializeActions(tx.actions)
    tx.actions[0].data = data[0].data;

    //Step3: send approval transaction(to approve kicking proposal) 
    //       as payload of another proposal
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
          requested: config.BP_PERMISSION,
          trx: tx
        },
      }]
    }, {
      blocksBehind: 3,
      expireSeconds: 30 * 60, // 30 minutes to expire
    });

    /*
    proposal = {
      transaction_id: 'd93111537dc771f34ec866eba40daaaee6b92e69af5351ccf3151bb6f4437c10',
      processed: {
        id:'d93111537dc771f34ec866eba40daaaee6b92e69af5351ccf3151bb6f4437c10',
        block_num: 115456895,
        block_time: '2020-04-14T12:07:04.500',
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
    let msg = util.format('Proposed a proposal to remove block producer, please review: https://bloks.io/transaction/%s Time: %s', proposal.transaction_id, now);
    notify_slack(msg);
  })();
}

function monitor(){
  const now = Date();
  (async () => {
    // Get proposals from Aloha Tracker
    fetch_bp_permission();
    if (config.BP_PERMISSION) {
      let resp = await rpc.get_table_rows({
        json: true,                                 // Get the response as json
        code: 'eosio.msig',                         // Contract that we target
        scope: config.ALOHA_TRACKER_ACCOUNT,        // Account that owns the data
        table: 'proposal',                          // Table name
        limit: 10,                                  // Maximum number of rows that we want to get
        reverse: false                              // False, means newest appear first
      });
      let kicking_proposals = resp.rows;

      // Get proposed kicking proposals by config.PROPOSER_ACCOUNT
      resp = await rpc.get_table_rows({
        json: true,                     // Get the response as json
        code: 'eosio.msig',             // Contract that we target
        scope: config.PROPOSER_ACCOUNT, // Account that owns the data
        table: 'proposal',              // Table name
        limit: 10,                      // Maximum number of rows that we want to get
        reverse: false                  // False, means newest appear first
      });
      let proposed_proposals = resp.rows;

      // Get approvals, if already approved, just ignore it
      resp = await rpc.get_table_rows({
        json: true,                                 // Get the response as json
        code: 'eosio.msig',                         // Contract that we target
        scope: config.ALOHA_TRACKER_ACCOUNT,        // Account that owns the data
        table: 'approvals2',                          // Table name
        limit: 10,                                  // Maximum number of rows that we want to get
        reverse: false                              // False, means newest appear first
      });
      let approvals = resp.rows;

      
      if(kicking_proposals.length == 0) {
        if(proposed_proposals.length > 0) {
          // No kicking_proposals, meaning all proposed_proposals should be canceled
          // Cancel proposed proposals
          proposed_proposals.forEach(function(p){
            cancel_proposal(p);
          });
        } else {
          console.log("No kicking proposal found. Time: %s", now);
        }
      } else {
        // Only process the first(newest) kicking proposal
        let kicking_proposal = kicking_proposals[0];
        let found_proposal_msg = util.format('Found kicking proposal: %s. Time: %s', kicking_proposal.proposal_name, now);
        let proposal_needed = true;
        var datetime = new Date();
        var minute = parseInt(datetime.toISOString().slice(14,16));
        proposed_proposals.forEach(function(value){
          if(value.proposal_name == kicking_proposal.proposal_name) {
            //Notify user every 5 minutes
            if (minute % 5 == 0) {
              notify_slack(found_proposal_msg);
              let msg = util.format('Kicking proposal already proposed, please review ASAP: https://bloks.io/msig/%s/%s Time: %s', config.PROPOSER_ACCOUNT, kicking_proposal.proposal_name, now);
              notify_slack(msg);
            }
            proposal_needed = false;
          }
        });

        if (approvals.length > 0){
          let approval = approvals[0]
          if (approval.proposal_name == kicking_proposal.proposal_name) {
            approval.provided_approvals.forEach(function(p){
              if (p.level.actor == config.BP_ACCOUNT) {
                //Notify user every 5 minutes
                if (minute % 5 == 0) {
                  notify_slack(found_proposal_msg);
                  msg = "Kicking proposal already approved, good job!"
                  notify_slack(msg)
                }
                proposal_needed = false
              }
            })
          }
        }

        if(proposal_needed) {
          console.log("Prepare to approve kicking proposal:", kicking_proposal.proposal_name);
          //Step2: propose to approve this kicking proposal
          propose(kicking_proposal)
        }
      }
    }
  })();
  // Check proposals every minute
  setTimeout(monitor, 1000 * 60);
}

monitor();
