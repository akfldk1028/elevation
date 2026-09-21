import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTranscription, validateVisualReview } from '../tools/facade-pipeline/perspective-workflow.mjs';
import { transcriptionPrompt, observationPrompt } from '../tools/facade-pipeline/workflow-prompts.mjs';
import { runPerspectiveWorkflow } from '../tools/facade-pipeline/perspective-workflow.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { defaultGeneratedImagesDir } from '../tools/facade-presentation/photo/codex-photo.mjs';

const observation = {features:[{id:'F1',description:'curved veil'}]};
const response = () => ({grammar:{schema_version:'arr.elevation3d.facade-grammar.v3', source_photograph:'concept.png',
  rules:[{name:'Veil',alternatives:[]}]}, feature_map:[{feature_id:'F1',rule:'Veil',implementation:'curved outline'}], unrepresented_features:[]});
test('generated image discovery follows the actual CODEX_HOME, not an unrelated user-home installation',()=>{
  assert.equal(defaultGeneratedImagesDir({CODEX_HOME:join(tmpdir(),'runtime-home')}),join(tmpdir(),'runtime-home','generated_images'));
});
test('the transcriber must bind the generated perspective and map its observed features to real rules',()=>{
  assert.doesNotThrow(()=>validateTranscription(response(),{sourceName:'concept.png',observation}));
  for (const change of [r=>r.grammar.source_photograph='mass.png', r=>r.feature_map=[],r=>r.feature_map[0].rule='Invented']) {
    const r=response(); change(r);
    assert.throws(()=>validateTranscription(r,{sourceName:'concept.png',observation}));
  }
});
test('a textual YES cannot accept a run without reviewing all supplied drawing views',()=>{
  const views=['front','right','back','left','axon','axon_back','hero'];
  assert.equal(validateVisualReview({verdict:'YES',checked_views:views,discrepancies:[]}, views),true);
  assert.equal(validateVisualReview({verdict:'YES',checked_views:['front'],discrepancies:[]}, views),false);
  assert.equal(validateVisualReview({verdict:'ROUGHLY',checked_views:views,discrepancies:[]}, views),false);
  assert.equal(validateVisualReview({verdict:'YES',checked_views:views,discrepancies:[{severity:'major'}]}, views),false);
});
test('transcription prompt receives generated image identity, segmentation, feature inventory and repair feedback',()=>{
  const prompt = transcriptionPrompt({brief:'BRIEF',schema:{},sourceName:'concept.png',sourceHash:'abc',observation,
    vision:{engine:'sam3',instances:27},previous:response(),feedback:{face:'right',missing:'curved veil'}});
  for(const needle of ['concept.png','abc','sam3','F1','curved veil','right','BRIEF','NOT an orthographic']) assert.ok(prompt.includes(needle),needle);
  assert.ok(!prompt.includes('Opaque red brick'));
});

async function fixture(t, {firstVerdict='YES',missingViews=false,unrepresented=false,relativeViews=false}={}) {
  const root=await mkdtemp(join(tmpdir(),'perspective-workflow-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'evidence','color'),{recursive:true});
  const png=await sharp({create:{width:100,height:100,channels:3,background:'#aaa'}}).png().toBuffer();
  await writeFile(join(root,'selected.glb'),'immutable test mass');
  await writeFile(join(root,'evidence','color','axon.png'),png);
  const calls=[];
  let reviews=0;
  const context={storeys:[{z_min:0,z_max:3}],facade_segments:[{length_m:10,ground_access:true}]};
  const dependencies={
    prepare:async()=>({runDir:root,candidate:{},context}),
    brief:async({runDir})=>{
      const paths={schema:join(runDir,'schema.json'),context:join(runDir,'context.json')};
      await writeFile(paths.schema,'{}'); await writeFile(paths.context,JSON.stringify(context));
      return {prompt:'CURRENT BRIEF',paths};
    },
    generate:async({outputPng})=>{calls.push('generate');await writeFile(outputPng,png);return {bound:true,session:'fixture'};},
    trace:async()=>{calls.push('sam3'); return {ok:true,engine:'sam3',instances:12};},
    task:async({name,prompt,images})=>{
      calls.push(name);
      if(name==='observation') return {value:{...observation,mass_matches:true,roi_px:[[0,0],[99,0],[99,99],[0,99]],photographed_faces:['front']},receipt:{fixture:true}};
      assert.equal(images[0],join(root,'test.agent','concept-test.png'));
      if(name==='transcription') {
        assert.ok(prompt.includes('"engine":"sam3"'));
        if(reviews) assert.ok(prompt.includes('missing veil'));
        const r=response(); r.grammar.source_photograph='concept-test.png';
        if(unrepresented) r.unrepresented_features=['curved veil'];
        return {value:r,receipt:{fixture:true}};
      }
      const verdict=reviews++===0?firstVerdict:'YES';
      return {value:{verdict,checked_views:['front','back','left','right','plan','top','axon','opposite-axon','hero'],
        discrepancies:verdict==='YES'?[]:[{description:'missing veil',severity:'major'}]},receipt:{fixture:true}};
    },
    check:()=>({ok:true}),
    draw:async({runDir})=>{
      calls.push('draw'); await mkdir(runDir,{recursive:true});
      const names=missingViews?['front']:['front','back','left','right','plan','top','axon','opposite-axon'];
      const views={};
      await mkdir(join(runDir,'technical-render'),{recursive:true});
      for(const name of [...names,'hero']) {
        const relative=relativeViews&&name!=='hero';
        const path=join(runDir,...(relative?['technical-render']:[]),name+'.png');
        await writeFile(path,png);views[name]={path:relative?name+'.png':path};
      }
      const glb=join(runDir,'model.glb');await writeFile(glb,'compiled fixture');
      return {technical:{views:Object.fromEntries(names.map(n=>[n,views[n]])),validation:{accepted:true}},
        hero:views.hero,compiled:{output:{path:glb}}};
    },
    compare:async()=>({source_fidelity:{accepted:true,checked:true}}),
  };
  return {root,calls,dependencies};
}
test('harness really carries generation through SAM, transcription, drawings and independent review',async t=>{
  const f=await fixture(t);
  const result=await runPerspectiveWorkflow({candidateId:'test',name:'test',idea:'curved screen'},f.dependencies);
  assert.equal(result.ok,true);
  assert.deepEqual(f.calls,['generate','observation','sam3','transcription','draw','review']);
  assert.equal(JSON.parse(await readFile(result.manifest,'utf8')).stage,'accepted');
});

test('actual renderer relative view paths resolve against the technical drawing directory',async t=>{
  const f=await fixture(t,{relativeViews:true});
  const result=await runPerspectiveWorkflow({candidateId:'test',name:'test',idea:'curved screen'},f.dependencies);
  assert.equal(result.ok,true);
  assert.equal(result.views.front,join(f.root,'test.agent','attempt-1','drawing','technical-render','front.png'));
});
test('a failed visual review goes back to transcription with the same concept, not another generated design',async t=>{
  const f=await fixture(t,{firstVerdict:'NO'});
  const result=await runPerspectiveWorkflow({candidateId:'test',name:'test',idea:'curved screen'},f.dependencies);
  assert.equal(result.ok,true);
  assert.equal(result.attempts.length,2);
  assert.equal(f.calls.filter(c=>c==='generate').length,1);
});
test('an incomplete drawing pack cannot be accepted even if a reviewer claims YES',async t=>{
  const f=await fixture(t,{missingViews:true});
  const result=await runPerspectiveWorkflow({candidateId:'test',name:'test',idea:'curved screen',maxAttempts:1},f.dependencies);
  assert.equal(result.ok,false);
});
test('unrepresented source features prevent acceptance',async t=>{
  const f=await fixture(t,{unrepresented:true});
  const result=await runPerspectiveWorkflow({candidateId:'test',name:'test',idea:'curved screen',maxAttempts:1},f.dependencies);
  assert.equal(result.ok,false);
  assert.equal(result.stage,'needs_correction');
});

test('resume repairs the same observed concept without regenerating or rerunning segmentation',async t=>{
  const f=await fixture(t,{firstVerdict:'NO'});
  const options={candidateId:'test',name:'test',idea:'curved screen',maxAttempts:1};
  const first=await runPerspectiveWorkflow(options,f.dependencies);
  assert.equal(first.ok,false);
  const resumed=await runPerspectiveWorkflow({...options,resume:true},f.dependencies);
  assert.equal(resumed.ok,true);
  assert.equal(resumed.attempts.length,2);
  for(const name of ['generate','observation','sam3']) assert.equal(f.calls.filter(c=>c===name).length,1);
});

test('missing source-comparison evidence cannot be treated as a successful comparison',async t=>{
  const f=await fixture(t);f.dependencies.compare=async()=>({});
  const result=await runPerspectiveWorkflow({candidateId:'test',name:'test',idea:'curved screen',maxAttempts:1},f.dependencies);
  assert.equal(result.ok,false);
});

test('resume rejects changed source pixels before invoking any actor',async t=>{
  const f=await fixture(t,{firstVerdict:'NO'});
  const opts={candidateId:'test',name:'test',idea:'curved screen',maxAttempts:1};
  const first=await runPerspectiveWorkflow(opts,f.dependencies),count=f.calls.length;
  await writeFile(first.source,'replaced source');
  await assert.rejects(()=>runPerspectiveWorkflow({...opts,resume:true},f.dependencies),/WORKFLOW_AUTHORITY_CHANGED/);
  assert.equal(f.calls.length,count);
});

test('rerender after an engine fix reuses the exact authored grammar and still requires visual review',async t=>{
  const f=await fixture(t,{firstVerdict:'NO'});
  const options={candidateId:'test',name:'test',idea:'curved screen',maxAttempts:1};
  await runPerspectiveWorkflow(options,f.dependencies);
  const result=await runPerspectiveWorkflow({...options,resume:true,rerender:true},f.dependencies);
  assert.equal(result.ok,true);
  assert.equal(f.calls.filter(c=>c==='transcription').length,1);
  assert.equal(f.calls.filter(c=>c==='review').length,2);
});

test('resume re-observes when observation.json was missing',async t=>{
  const f=await fixture(t);
  const opts={candidateId:'test',name:'test',idea:'curved screen',maxAttempts:1};
  let obsCalls = 0;
  const originalTask = f.dependencies.task;
  f.dependencies.task = async(args) => {
    if (args.name === 'observation' && obsCalls++ === 0) throw new Error('INTERRUPTED_BEFORE_OBSERVATION');
    return originalTask(args);
  };
  await assert.rejects(()=>runPerspectiveWorkflow(opts,f.dependencies),/INTERRUPTED_BEFORE_OBSERVATION/);
  const resumed = await runPerspectiveWorkflow({...opts,resume:true},f.dependencies);
  assert.equal(resumed.ok,true);
  assert.equal(resumed.vision_ok,true);
});

test('requireVision rejects run when vision fails',async t=>{
  const f=await fixture(t);
  f.dependencies.trace = async () => { throw new Error('SAM_GPU_OUT_OF_MEMORY'); };
  const opts={candidateId:'test',name:'test',idea:'curved screen',maxAttempts:1};
  const result = await runPerspectiveWorkflow(opts,{...f.dependencies,requireVision:true});
  assert.equal(result.ok,false);
  assert.equal(result.vision_ok,false);
});

