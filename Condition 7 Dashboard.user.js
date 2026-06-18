// ==UserScript==
// @name         Condition 7 Standalone Dashboard Helper - NCL1
// @namespace    wprijaco.condition7.standalone.helper
// @version      1.3.2
// @description  Hosted/local standalone helper that fetches Rodeo Scanned ItemList in the background and sends one deduplicated Slack callout alert per shipment.
// @author       Prince Jacob (Wprijaco)
// @match        file:///*
// @match        https://p2rc7dwell.thejacobslab.com/*
// @connect      rodeo-dub.amazon.com
// @connect      hooks.slack.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function(){
'use strict';

if(!document.querySelector('meta[name="condition7-dashboard"][content="wprijaco-v1"]')) return;

// Prevent duplicate copies of this helper from running on the same dashboard page.
const INSTANCE_ATTRIBUTE='data-condition7-helper-active';
if(document.documentElement.hasAttribute(INSTANCE_ATTRIBUTE)){
  console.warn('[Condition 7 Standalone] Another helper instance is already active. This copy will stop.');
  return;
}
document.documentElement.setAttribute(INSTANCE_ATTRIBUTE,'1.3.2');

const REFRESH_MS=60000;
const CPT_OFFSET_MIN=60;
const SHIP_CALLOUT_MIN=45;
const SLACK_MAX_PER_REFRESH=5;
const SLACK_MEMORY_HOURS=12;
const TARGET_URL='http://rodeo-dub.amazon.com/NCL1/ItemList?_enabledColumns=on&enabledColumns=OUTER_SCANNABLE_ID&enabledColumns=ASIN_TITLES&WorkPool=Scanned&Fracs=NON_FRACS&DwellTimeGreaterThan=0.5&DwellTimeLessThan=2.1333333333333333&ProcessPath=PPPickToRebin4%2cPPPickToRebin2%2cPPPickToRebin3&shipmentType=CUSTOMER_SHIPMENTS';
const STORAGE={
  slackWebhook:'condition7StandaloneSlackWebhookV1',
  slackEnabled:'condition7StandaloneSlackEnabledV1',
  slackSentMap:'condition7StandaloneSlackSentMapV1'
};

let running=false,paused=false,timer=null;
const slackPending=new Set();
const clean=s=>String(s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
const normalizeShipmentId=value=>{const text=clean(value);const match=text.match(/\b\d{10,}\b/);return match?match[0]:text;};
const sendStatus=(message,detail='',level='info')=>document.dispatchEvent(new CustomEvent('condition7-status',{detail:{message,detail,level}}));
const sendData=detail=>document.dispatchEvent(new CustomEvent('condition7-data',{detail}));
const gmGet=(key,fallback)=>{try{return GM_getValue(key,fallback)}catch(_){return fallback}};
const gmSet=(key,value)=>{try{GM_setValue(key,value)}catch(_){}};

function slackWebhook(){return String(gmGet(STORAGE.slackWebhook,'')||'').trim()}
function slackEnabled(){return gmGet(STORAGE.slackEnabled,false)===true}
function validSlackWebhook(url){return /^https:\/\/hooks\.slack\.com\/(services|triggers)\//i.test(String(url||'').trim())}
function loadSlackSent(){try{return JSON.parse(gmGet(STORAGE.slackSentMap,'{}')||'{}')||{}}catch(_){return {}}}
function saveSlackSent(map){gmSet(STORAGE.slackSentMap,JSON.stringify(map||{}))}
function sendSlackStatus(message='',toast=''){
  document.dispatchEvent(new CustomEvent('condition7-slack-status',{detail:{
    configured:validSlackWebhook(slackWebhook()),
    enabled:slackEnabled(),
    message:message||`Webhook configured: ${validSlackWebhook(slackWebhook())?'Yes':'No'}. Automatic callout alerts are ${slackEnabled()?'enabled':'disabled'}.`,
    toast
  }}));
}

function parseDwell(text){text=clean(text).toLowerCase();if(!text)return 0;let h=text.match(/(\d+(?:\.\d+)?)\s*h/),m=text.match(/(\d+(?:\.\d+)?)\s*m/);if(h||m)return Math.round((h?+h[1]*60:0)+(m?+m[1]:0));let c=text.match(/(\d+):(\d{2})/);if(c)return +c[1]*60 + +c[2];let n=text.match(/\d+(?:\.\d+)?/);if(!n)return 0;return text.includes('.')?Math.round(+n[0]*60):Math.round(+n[0]);}
function formatDwell(m){m=Number(m)||0;const h=Math.floor(Math.abs(m)/60),n=Math.abs(m)%60,s=m<0?'-':'';return h?`${s}${h}h ${n}m`:`${s}${n}m`}
function parseDate(text){text=clean(text);if(!text)return null;let d=new Date(text);if(!isNaN(d))return d;let m=text.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\s+(\d{1,2}):(\d{2})/);if(m){let y=+m[3];if(y<100)y+=2000;d=new Date(y,+m[2]-1,+m[1],+m[4],+m[5]);if(!isNaN(d))return d}return null;}
function shortDate(d){if(!d)return '-';return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`}
function columnMap(table){const map={};table.querySelectorAll('thead th').forEach((th,i)=>{const n=clean(th.innerText).toLowerCase();if(n)map[n]=i});return map}
function idx(map,names){for(const n of names){const k=n.toLowerCase();if(Object.prototype.hasOwnProperty.call(map,k))return map[k]}return -1}
function cell(cells,i){return i>=0&&cells[i]?cells[i]:null}
function txt(cells,i){const el=cell(cells,i);return el?clean(el.innerText):''}
function directShipmentUrl(cells,index,shipmentId){
  const el=cell(cells,index);
  if(el){
    const links=[...el.querySelectorAll('a[href]')];
    const exact=links.find(a=>/\/warehouse\/NCL1\/shipment\//i.test(a.getAttribute('href')||''));
    if(exact)return exact.getAttribute('href');
  }
  return `https://eu.hitch.aft.amazon.dev/warehouse/NCL1/shipment/${encodeURIComponent(shipmentId)}`;
}

function parseHTML(html){
 const doc=new DOMParser().parseFromString(html,'text/html');
 const table=doc.querySelector('table.result-table');
 if(!table) throw new Error(/midway|sign in|login/i.test(doc.body.innerText)?'Authentication page received. Open Rodeo and sign in first.':'Rodeo result table not found.');
 const map=columnMap(table), I={shipment:idx(map,['Shipment ID']),condition:idx(map,['Condition']),expected:idx(map,['Expected Ship Date']),dwell:idx(map,['Dwell Time','Dwell Time (hours)']),scannable:idx(map,['Scannable ID']),process:idx(map,['Process Path']),qty:idx(map,['Quantity']),fnsku:idx(map,['FN SKU']),title:idx(map,['Title','ASIN Title','ASIN Titles']),outer:idx(map,['Outer Scannable ID'])};
 const missing=[['Shipment ID',I.shipment],['Condition',I.condition],['Expected Ship Date',I.expected],['Dwell Time',I.dwell],['Scannable ID',I.scannable],['Outer Scannable ID',I.outer]].filter(x=>x[1]<0).map(x=>x[0]);
 if(missing.length) throw new Error(`Missing Rodeo columns: ${missing.join(', ')}`);
 const groups=new Map(), now=Date.now();
 const rows=[...table.querySelectorAll('tbody tr')];
 for(const row of rows){
   const c=[...row.children];if(!c.length)continue;
   const condition=Number(txt(c,I.condition));if(condition!==7)continue;
   const shipmentId=normalizeShipmentId(txt(c,I.shipment))||'Unknown';
   const expectedText=txt(c,I.expected);
   const expectedDate=parseDate(expectedText);
   const cptDate=expectedDate?new Date(expectedDate.getTime()-CPT_OFFSET_MIN*60000):null;
   const minutesToShip=expectedDate?Math.round((expectedDate-now)/60000):null;
   const dwellText=txt(c,I.dwell);
   const dwell=parseDwell(dwellText);
   const processPath=txt(c,I.process);
   const floor=(processPath.match(/PPPickToRebin([234])/i)||[])[1]||'Other';
   const outerScannableId=txt(c,I.outer)||'-';
   const item={scannableId:txt(c,I.scannable),outerScannableId,processPath,qty:Number(txt(c,I.qty))||0,fnsku:txt(c,I.fnsku),title:txt(c,I.title),dwell,dwellText,floor};
   if(!groups.has(shipmentId))groups.set(shipmentId,{
     shipmentId,
     shipmentUrl:directShipmentUrl(c,I.shipment,shipmentId),
     items:[],totalQty:0,maxDwell:0,maxDwellText:'',expectedText,cptText:shortDate(cptDate),minutesToShip,
     calloutRisk:minutesToShip!==null&&minutesToShip<=SHIP_CALLOUT_MIN,
     processPaths:new Set(),floors:new Set()
   });
   const g=groups.get(shipmentId);
   g.items.push(item);g.totalQty+=item.qty;
   if(dwell>=g.maxDwell){g.maxDwell=dwell;g.maxDwellText=dwellText||formatDwell(dwell)}
   if(item.processPath)g.processPaths.add(item.processPath);if(item.floor)g.floors.add(item.floor);
   if(minutesToShip!==null&&(g.minutesToShip===null||minutesToShip<g.minutesToShip)){
     g.minutesToShip=minutesToShip;g.expectedText=expectedText;g.cptText=shortDate(cptDate);
   }
   g.calloutRisk=g.calloutRisk||(minutesToShip!==null&&minutesToShip<=SHIP_CALLOUT_MIN);
 }
 const shipments=[...groups.values()].map(g=>({...g,processPaths:[...g.processPaths],floors:[...g.floors]})).sort((a,b)=>Number(b.calloutRisk)-Number(a.calloutRisk)||b.maxDwell-a.maxDwell);
 return {shipments,sourceRows:rows.length};
}

function slackKey(s){return `${s.shipmentId}|${s.expectedText||''}`}
function slackText(s,testMode=false){
  if(testMode)return '🧪 Condition 7 Slack test from the standalone NCL1 dashboard. Slack alerts are configured correctly.';
  const pairs=[...new Set((s.items||[]).map(i=>`${i.scannableId||'-'} / ${i.outerScannableId||'-'}`))].join('\n');
  return [
    '🚨 *Condition 7 Callout Risk - NCL1*',
    `*Shipment:* <${s.shipmentUrl}|${s.shipmentId}>`,
    `*Expected Ship Date:* ${s.expectedText||'-'}`,
    `*Scannable / Outer:*\n${pairs||'-'}`,
    `*Dwell Time:* ${formatDwell(s.maxDwell)}`,
    `*Ship time remaining:* ${formatDwell(s.minutesToShip)}`
  ].join('\n');
}
function slackPayload(s,testMode=false){
  if(testMode)return {text:slackText(null,true),severity:'TEST',site:'NCL1'};
  const scannables=[...new Set((s.items||[]).map(i=>i.scannableId).filter(Boolean))].join(', ');
  const outers=[...new Set((s.items||[]).map(i=>i.outerScannableId).filter(Boolean))].join(', ');
  return {
    text:slackText(s,false),
    severity:'CALL_OUT_RISK',
    site:'NCL1',
    shipment:s.shipmentId,
    shipment_url:s.shipmentUrl,
    expected_ship:s.expectedText||'-',
    scannable:scannables||'-',
    outer_scannable:outers||'-',
    dwell:formatDwell(s.maxDwell),
    ship_left:formatDwell(s.minutesToShip)
  };
}
function postSlack(payload,overrideWebhook=''){
  const webhook=String(overrideWebhook||slackWebhook()).trim();
  return new Promise((resolve,reject)=>{
    if(!validSlackWebhook(webhook))return reject(new Error('Slack webhook is not configured'));
    GM_xmlhttpRequest({
      method:'POST',url:webhook,headers:{'Content-Type':'application/json'},data:JSON.stringify(payload),timeout:20000,
      onload:r=>r.status>=200&&r.status<300?resolve(r):reject(new Error(`Slack HTTP ${r.status}: ${r.responseText||'No response'}`)),
      onerror:()=>reject(new Error('Slack network request failed')),
      ontimeout:()=>reject(new Error('Slack request timed out'))
    });
  });
}
function consolidateCalloutShipments(shipments){
  const grouped=new Map();
  for(const original of shipments||[]){
    if(!original||!original.calloutRisk)continue;
    const shipmentId=normalizeShipmentId(original.shipmentId)||'Unknown';
    if(!grouped.has(shipmentId)){
      grouped.set(shipmentId,{...original,shipmentId,items:[...(original.items||[])]});
      continue;
    }
    const current=grouped.get(shipmentId);
    current.items.push(...(original.items||[]));
    if(Number(original.maxDwell||0)>Number(current.maxDwell||0)){
      current.maxDwell=original.maxDwell;
      current.maxDwellText=original.maxDwellText;
    }
    if(current.minutesToShip==null||(original.minutesToShip!=null&&original.minutesToShip<current.minutesToShip)){
      current.minutesToShip=original.minutesToShip;
      current.expectedText=original.expectedText;
      current.shipmentUrl=original.shipmentUrl||current.shipmentUrl;
    }
  }
  for(const shipment of grouped.values()){
    const seen=new Set();
    shipment.items=shipment.items.filter(item=>{
      const itemKey=`${clean(item.scannableId)}|${clean(item.outerScannableId)}|${clean(item.fnsku)}`;
      if(seen.has(itemKey))return false;
      seen.add(itemKey);return true;
    });
  }
  return [...grouped.values()];
}

function processSlackAlerts(shipments){
  if(!slackEnabled()||!validSlackWebhook(slackWebhook()))return;
  const now=Date.now(),sent=loadSlackSent();
  Object.keys(sent).forEach(k=>{if(now-Number(sent[k]||0)>SLACK_MEMORY_HOURS*3600000)delete sent[k]});
  saveSlackSent(sent);

  const callouts=consolidateCalloutShipments(shipments);
  let started=0;
  for(const s of callouts){
    if(started>=SLACK_MAX_PER_REFRESH)break;
    const key=slackKey(s);
    if(sent[key]||slackPending.has(key))continue;

    // Reserve the shipment BEFORE the asynchronous Slack request begins.
    // This blocks duplicate helper copies/tabs from posting the same shipment concurrently.
    const reservationTime=Date.now();
    const latest=loadSlackSent();
    if(latest[key])continue;
    latest[key]=reservationTime;
    saveSlackSent(latest);

    slackPending.add(key);started++;
    postSlack(slackPayload(s,false)).then(()=>{
      const current=loadSlackSent();
      current[key]=Date.now();
      saveSlackSent(current);
      sendSlackStatus(`Slack alert sent for shipment ${s.shipmentId}`,`Slack alert sent: ${s.shipmentId}`);
    }).catch(err=>{
      // Remove only this failed reservation so a later refresh can retry.
      const current=loadSlackSent();
      if(Number(current[key]||0)===reservationTime){delete current[key];saveSlackSent(current);}
      console.error('[Condition 7 Standalone] Slack failed:',err);
      sendSlackStatus(`Slack alert failed: ${err.message}`,'Slack alert failed');
    }).finally(()=>slackPending.delete(key));
  }
}

function fetchNow(){
 if(paused||running)return;
 running=true;sendStatus('Refreshing Rodeo data…','Background request in progress');
 GM_xmlhttpRequest({
   method:'GET',url:TARGET_URL,timeout:45000,
   onload:r=>{
     try{
       if(r.status<200||r.status>=400)throw new Error(`HTTP ${r.status}`);
       const parsed=parseHTML(r.responseText);
       sendData(parsed);
       processSlackAlerts(parsed.shipments);
     }catch(e){sendStatus('Unable to read Rodeo data',e.message,'error')}
     finally{running=false}
   },
   onerror:()=>{running=false;sendStatus('Rodeo request failed','Check network, Midway and Rodeo login','error')},
   ontimeout:()=>{running=false;sendStatus('Rodeo request timed out','Try again after opening Rodeo in another tab','error')}
 });
}
function schedule(){clearInterval(timer);timer=setInterval(fetchNow,REFRESH_MS)}

document.addEventListener('condition7-command',e=>{
 const d=e.detail||{},a=d.action;
 if(a==='refresh')fetchNow();
 if(a==='pause'){paused=true;sendStatus('Paused','Background refresh is stopped')}
 if(a==='resume'){paused=false;sendStatus('Resumed','Refreshing every 60 seconds');fetchNow()}
 if(a==='slack-status')sendSlackStatus();
 if(a==='slack-save'){
   const supplied=String(d.webhook||'').trim();
   if(supplied&&!validSlackWebhook(supplied)){sendSlackStatus('Invalid Slack webhook URL','Invalid Slack webhook');return;}
   if(supplied)gmSet(STORAGE.slackWebhook,supplied);
   gmSet(STORAGE.slackEnabled,Boolean(d.enabled));
   sendSlackStatus('Slack settings saved','Slack settings saved');
 }
 if(a==='slack-test'){
   const supplied=String(d.webhook||'').trim();
   if(supplied&&!validSlackWebhook(supplied)){sendSlackStatus('Invalid Slack webhook URL','Invalid Slack webhook');return;}
   if(supplied)gmSet(STORAGE.slackWebhook,supplied);
   postSlack(slackPayload(null,true),supplied).then(()=>sendSlackStatus('Slack test sent successfully','Slack test sent')).catch(err=>sendSlackStatus(`Slack test failed: ${err.message}`,'Slack test failed'));
 }
 if(a==='slack-clear-history'){
   saveSlackSent({});
   sendSlackStatus('Slack alert history reset. Current callouts may alert again on the next refresh.','Slack history reset');
 }
});

document.addEventListener('condition7-dashboard-ready',()=>{
  sendStatus('Helper connected','Refreshing every 60 seconds');
  sendSlackStatus();
  fetchNow();schedule();
});
setTimeout(()=>{sendSlackStatus();fetchNow();schedule()},500);
})();
