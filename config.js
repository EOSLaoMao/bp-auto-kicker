const ALOHA_TRACKER_ACCOUNT = 'alohatracker' // This account is fixed, DO NOT MODIFY
const RPC_HOST = process.env.RPC_HOST || 'https://api.eoslaomao.com:443'
const BP_ACCOUNT = process.env.BP_ACCOUNT
const BP_PERMISSION_NAME = process.env.BP_PERMISSION_NAME || 'active'
const PROPOSER_ACCOUNT = process.env.PROPOSER_ACCOUNT
const PROPOSER_PRIVATE_KEY = process.env.PROPOSER_PRIVATE_KEY
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL
const SENTRY_DSN = process.env.SENTRY_DSN

module.exports = {
  RPC_HOST,
  ALOHA_TRACKER_ACCOUNT,
  BP_ACCOUNT,
  BP_PERMISSION_NAME,
  PROPOSER_ACCOUNT,
  PROPOSER_PRIVATE_KEY,
  SLACK_WEBHOOK_URL,
  SENTRY_DSN
}
