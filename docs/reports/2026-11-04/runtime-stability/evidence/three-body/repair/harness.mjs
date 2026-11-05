import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const root='/workspace/codex_cloud/test-results/runtime-stability/three-body';
const out=root+'/repair';
await mkdir(out,{recursive:true});
const original=JSON.parse(await readFile(root+'/report.json','utf8'));
assert.equal(original.status,'completed');
const prompt=`独立验收发现两个明确问题，请只做局部修正，不重新积分、不重绘PNG，不修改CSV或metrics.json。无需再次确认，最多4次工具调用后直接给最终答复。
1. three_body.html 里“周期约6.916”的说明不准确。这组初值的8字轨道周期约6.3259，t=12.65约为两个周期；若未实际估算周期，也可以直接删除具体周期数字，保留“这是特定初值的数值模拟而非三体通解”。必须同时修正 simulate_three_body.py 中的相同HTML模板，避免复现时再次生成错误说明。
2. 手机390px屏幕的应用预览iframe有效宽度360px，文档scrollWidth为367px，有7px横向溢出。请检查布局/网格/控件最小宽度，局部调整CSS使360px及390px均无横向溢出，保留可读文字、canvas正确比例、暂停/继续/重置/时间滑块。不要仅隐藏overflow掩盖被裁切内容；允许长文本换行并令网格项目可收缩。
只修改现有HTML和生成器中的对应模板，不改变嵌入的1266行数据或任何物理参数。修改前后检查CSV/metrics/PNG SHA256一致，HTML内嵌数据也完全一致。不得运行生成器main以免重写已有成果。可以用一次exec_command运行Python局部编辑，再一次命令验证；无需额外美化或扩展模拟。完成后给出原CSV、metrics、PNG、修正HTML和复现脚本链接并结束。`;
await writeFile(out+'/prompt.txt',prompt);
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const ctx=await browser.newContext({baseURL:'http://127.0.0.1:5173',storageState:'/tmp/famsun-acceptance-admin.json',viewport:{width:1440,height:1000}});
const page=await ctx.newPage();
const report={session_id:original.session_id,previous_run_id:original.run_id,live_provider:true,browser_errors:[]};
page.on('pageerror',e=>report.browser_errors.push(e.message));
async function save(n,v){await writeFile(out+'/'+n,JSON.stringify(v,null,2)+'\n');}
async function get(u){const r=await ctx.request.get(u);assert.equal(r.status(),200);return r.json();}
try{
 await page.goto('/');const detail=await get('/api/sessions/'+report.session_id);
 await page.locator('.session-select').filter({hasText:detail.session.title}).first().click();
 await page.getByLabel('发送给丰尚助手的消息').fill(prompt);
 const pending=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/sessions/${report.session_id}/runs`&&r.request().method()==='POST');
 await page.getByRole('button',{name:'发送消息',exact:true}).click();const response=await pending;assert.equal(response.status(),201);const run=await response.json();
 report.run_id=run.id;report.submitted_at=new Date().toISOString();await save('report.json',report);console.log('SUBMITTED',report.run_id);
 const end=Date.now()+15*60*1000;let last=0;
 while(Date.now()<end){
  const run=await get('/api/runs/'+report.run_id);let cursor=0,events=[];
  for(;;){const part=await get(`/api/runs/${report.run_id}/timeline?after=${cursor}&limit=1000`);events.push(...part.events);if(!part.has_more)break;cursor=part.next_cursor;}
  Object.assign(report,{status:run.status,error:run.error,event_count:events.length});await save('events.json',events);await save('report.json',report);
  if(Date.now()-last>15000){console.log('PROGRESS',run.status,events.length);last=Date.now();}
  if(['completed','failed','cancelled'].includes(run.status))break;
  await page.waitForTimeout(2500);
 }
 const detail2=await get('/api/sessions/'+report.session_id);report.files=detail2.files;report.answer=detail2.messages.filter(m=>m.run_id===report.run_id&&m.role==='assistant').map(m=>m.content).join('\n');report.finished_at=new Date().toISOString();report.duration_seconds=(Date.now()-Date.parse(report.submitted_at))/1000;
 await save('session.json',detail2);await save('report.json',report);await writeFile(out+'/answer.md',report.answer);await page.screenshot({path:out+'/final-answer.png',fullPage:true});
 assert.equal(report.status,'completed');console.log('FINISHED',report.duration_seconds,report.event_count);
}finally{await browser.close();}
