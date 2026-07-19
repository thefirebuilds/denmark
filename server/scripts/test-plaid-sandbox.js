require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
const axios = require("axios");

const args = process.argv.slice(2);
function arg(name) { const index=args.indexOf(`--${name}`); return index>=0?args[index+1]:""; }
const clientId=arg("client-id")||process.env.PLAID_CLIENT_ID;
const secret=arg("secret")||process.env.PLAID_SECRET;
if(!clientId||!secret){console.error("Usage: npm.cmd run test:plaid-sandbox -- --client-id CLIENT_ID --secret SANDBOX_SECRET");process.exit(1);}
const api=axios.create({baseURL:"https://sandbox.plaid.com",timeout:45000});
async function post(path,body={}){const {data}=await api.post(path,{client_id:clientId,secret,...body});return data;}

(async()=>{
  const created=await post("/sandbox/public_token/create",{institution_id:"ins_109508",initial_products:["transactions"],options:{override_username:"user_transactions_dynamic",override_password:"pass_good"}});
  const exchanged=await post("/item/public_token/exchange",{public_token:created.public_token});
  let cursor=null,hasMore=true,transactions=[];
  while(hasMore){const page=await post("/transactions/sync",{access_token:exchanged.access_token,cursor,count:500});transactions.push(...(page.added||[]),...(page.modified||[]));cursor=page.next_cursor;hasMore=page.has_more;}
  console.log(JSON.stringify({item_id:exchanged.item_id,count:transactions.length,transactions:transactions.slice(0,5).map(tx=>({date:tx.date,name:tx.merchant_name||tx.name,amount:tx.amount,pending:tx.pending,account_id:tx.account_id}))},null,2));
})().catch(error=>{console.error(JSON.stringify(error.response?.data||{error:error.message},null,2));process.exit(1);});
