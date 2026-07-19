const express=require("express");
const service=require("../services/plaid/plaid");
const {getPlaidSettings,sanitizePlaidSettings,savePlaidSettings}=require("../services/plaid/plaidSettings");
const {logRequestActivity}=require("../services/systemActivityLog");
const router=express.Router();
function fail(res,error){console.error("[plaid]",error.details||error);res.status(error.status||500).json({error:error.message,code:error.code||null,details:error.details||null});}
router.get("/config",async(_q,res)=>{try{res.json(sanitizePlaidSettings(await getPlaidSettings()));}catch(e){fail(res,e);}});
router.put("/config",async(req,res)=>{try{res.json(sanitizePlaidSettings(await savePlaidSettings(req.body||{})));}catch(e){fail(res,e);}});
router.get("/summary",async(_q,res)=>{try{res.json(await service.getSummary());}catch(e){fail(res,e);}});
router.post("/link-token",async(req,res)=>{try{res.json(await service.createLinkToken(`denmark-${req.auth?.userId||"owner"}`,req.body?.itemId||null));}catch(e){fail(res,e);}});
router.post("/exchange",async(req,res)=>{try{if(!req.body?.publicToken)return res.status(400).json({error:"publicToken is required"});res.json(await service.savePublicToken(req.body.publicToken,req.body.metadata));}catch(e){fail(res,e);}});
router.post("/sync",async(req,res)=>{try{res.json(await service.syncTransactions({reason:req.body?.reason||"manual",allowInitialImport:true}));}catch(e){fail(res,e);}});
router.post("/balances/refresh",async(_q,res)=>{try{res.json(await service.refreshBalances());}catch(e){fail(res,e);}});
router.get("/balances",async(_q,res)=>{try{res.json(await service.getCachedBalances());}catch(e){fail(res,e);}});
router.get("/citi-4483/balance",async(_q,res)=>{try{res.json(await service.getCiti4483BalanceSummary());}catch(e){fail(res,e);}});
router.post("/items/:itemId/webhook",async(req,res)=>{try{res.json(await service.configureItemWebhook(req.params.itemId));}catch(e){fail(res,e);}});
router.delete("/items/:itemId",async(req,res)=>{try{const result=await service.removeItem(req.params.itemId);await logRequestActivity(req,{category:"integration",eventType:"plaid_item_disconnected",severity:"notice",outcome:"success",subjectType:"plaid_item",subjectId:result.itemId,subjectLabel:result.institutionName||"Plaid Item",source:"settings",details:{requestId:result.requestId,historyRetained:true}}).catch(error=>console.error("[plaid] failed to audit Item disconnect:",error));res.json(result);}catch(e){fail(res,e);}});
module.exports=router;
