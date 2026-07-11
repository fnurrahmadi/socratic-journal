const SYSTEM_PROMPT = `You are a Socratic Journaling Companion. Your sole purpose is to help the user clarify their thoughts, uncover hidden assumptions, and work through complex problems.
Strict Rules:
1. Never offer solutions, advice, or summaries. Do not tell them what to do.
2. Be incredibly brief (maximum 2-3 sentences).
3. End every response with exactly ONE clear, deep, open-ended question. Never ask multiple questions.
4. Actively listen for logical gaps, cognitive distortions, or unstated assumptions, and gently ask a question about that specific pivot point.
5. Tone: Grounded, empathetic, non-judgmental, and intellectually curious.
6. If the user expresses immediate danger, self-harm, harm to others, or a medical emergency, briefly encourage contacting local emergency services or a crisis service now, then ask one immediate safety-focused question.`;

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MODEL = "llama-3.3-70b-versatile";
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function corsHeaders(origin, allowedOrigin) {
  return { "Access-Control-Allow-Origin": origin === allowedOrigin ? origin : allowedOrigin, "Access-Control-Allow-Methods":"POST, OPTIONS", "Access-Control-Allow-Headers":"Content-Type", "Cache-Control":"no-store", "Vary":"Origin" };
}
function json(body,status,headers) { return new Response(JSON.stringify(body),{status,headers:{...headers,"Content-Type":"application/json"}}); }
function base64Url(bytes) { let binary=""; for(const byte of bytes) binary+=String.fromCharCode(byte); return btoa(binary).replaceAll("+","-").replaceAll("/","_").replaceAll("=",""); }
function base64UrlBytes(value) { const padded=value.replaceAll("-","+").replaceAll("_","/")+"===".slice((value.length+3)%4); const binary=atob(padded); return Uint8Array.from(binary,char=>char.charCodeAt(0)); }
async function hmacKey(secret) { return crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]); }

async function createSessionProof(env, request) {
  if (!env.SESSION_SIGNING_KEY) return "";
  const payload=base64Url(encoder.encode(JSON.stringify({exp:Date.now()+SESSION_DURATION_MS,origin:request.headers.get("Origin")||"",ua:request.headers.get("User-Agent")||""})));
  const signature=new Uint8Array(await crypto.subtle.sign("HMAC",await hmacKey(env.SESSION_SIGNING_KEY),encoder.encode(payload)));
  return `${payload}.${base64Url(signature)}`;
}
async function verifySessionProof(proof, env, request) {
  if (!env.SESSION_SIGNING_KEY || !proof || typeof proof!=="string") return false;
  try {
    const [payload,signature,...extra]=proof.split(".");
    if (!payload || !signature || extra.length) return false;
    const isValid=await crypto.subtle.verify("HMAC",await hmacKey(env.SESSION_SIGNING_KEY),base64UrlBytes(signature),encoder.encode(payload));
    if (!isValid) return false;
    const data=JSON.parse(decoder.decode(base64UrlBytes(payload)));
    return data.exp>Date.now() && data.origin===(request.headers.get("Origin")||"") && data.ua===(request.headers.get("User-Agent")||"");
  } catch { return false; }
}
async function verifyTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token || typeof token!=="string") return false;
  const response=await fetch(TURNSTILE_URL,{method:"POST",body:JSON.stringify({secret:env.TURNSTILE_SECRET_KEY,response:token,remoteip:request.headers.get("cf-connecting-ip")||undefined}),headers:{"Content-Type":"application/json"}});
  return Boolean((await response.json()).success);
}

export default { async fetch(request,env) {
  const origin=request.headers.get("Origin")||"", headers=corsHeaders(origin,env.ALLOWED_ORIGIN);
  if(request.method==="OPTIONS") return new Response(null,{headers});
  if(request.method!=="POST"||new URL(request.url).pathname!=="/chat") return json({error:"Not found."},404,headers);
  if(origin!==env.ALLOWED_ORIGIN) return json({error:"This origin is not permitted."},403,headers);
  try {
    if(env.CHAT_RATE_LIMITER) { const result=await env.CHAT_RATE_LIMITER.limit({key:request.headers.get("cf-connecting-ip")||"unknown"}); if(!result.success) return json({error:"Too many reflections. Please wait a minute and try again."},429,headers); }
    const body=await request.json(), messages=body?.messages;
    if(!Array.isArray(messages)||messages.length<1||messages.length>40) return json({error:"Invalid conversation."},400,headers);
    if(!messages.every(message=>message&&["user","assistant"].includes(message.role)&&typeof message.content==="string"&&message.content.length<=6000)) return json({error:"Invalid message content."},400,headers);
    const hasSession=await verifySessionProof(body?.sessionProof,env,request);
    if(!hasSession && !(await verifyTurnstile(body?.turnstileToken,request,env))) return json({error:"Verification expired or failed. Please try again."},403,headers);
    const groqResponse=await fetch(GROQ_URL,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${env.GROQ_API_KEY}`},body:JSON.stringify({model:MODEL,messages:[{role:"system",content:SYSTEM_PROMPT},...messages],temperature:.7,max_tokens:180})});
    const data=await groqResponse.json();
    if(!groqResponse.ok) return json({error:data?.error?.message||"The AI service could not respond."},groqResponse.status,headers);
    const message=data?.choices?.[0]?.message?.content?.trim();
    if(!message) return json({error:"No reflection was returned."},502,headers);
    return json({message,sessionProof:hasSession?body.sessionProof:await createSessionProof(env,request)},200,headers);
  } catch { return json({error:"The request could not be processed."},500,headers); }
} };
