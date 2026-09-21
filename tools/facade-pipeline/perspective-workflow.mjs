/** MASS -> generated PERSPECTIVE -> observed features -> grammar -> drawings -> visual repair. */
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { prepareFacadeContext } from './prepare.mjs';
import { writeFacadeBrief, checkFacadeGrammar, renderFacadeScheme } from './index.mjs';
import { codexPhoto } from '../facade-presentation/photo/codex-photo.mjs';
import { buildConceptSubject } from '../facade-presentation/photo/concept-subject.mjs';
import { runCodexTask } from './codex-task.mjs';
import { observationPrompt, transcriptionPrompt, reviewPrompt, WORKFLOW_PROMPT_REVISION } from './workflow-prompts.mjs';
import { traceFacade } from './vision.mjs';
import { compareDrawingToSource } from './source-check.mjs';
import { summarizeVisionEvidence } from './vision-evidence.mjs';
import { inlineLatticeInstances } from './lattice.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path,value) => writeFile(path, JSON.stringify(value,null,2), 'utf8');
const safeName = value => typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(value);
export const REQUIRED_DRAWING_VIEWS = ['front','back','left','right','plan','top','axon','opposite-axon'];

export function validateTranscription(response, {sourceName, observation}) {
  const grammar = response?.grammar;
  if (grammar?.schema_version !== 'arr.elevation3d.facade-grammar.v3' || grammar.source_photograph !== sourceName)
    throw new Error('TRANSCRIPTION_SOURCE_MISMATCH: grammar must name the exact generated perspective');
  const rules = new Set(Array.isArray(grammar.rules) ? grammar.rules.map(r=>r.name) : Object.keys(grammar.rules ?? {}));
  if (!Array.isArray(response.feature_map) || !Array.isArray(response.unrepresented_features)) throw new Error('FEATURE_ACCOUNTING_REQUIRED');
  for (const feature of observation.features) {
    const mapping = response.feature_map.find(m=>m.feature_id===feature.id);
    if (!mapping || !rules.has(mapping.rule) || !mapping.implementation) throw new Error(`UNMAPPED_SOURCE_FEATURE: ${feature.id}`);
  }
}

export function validateVisualReview(review, requiredViews) {
  return review?.verdict === 'YES' && Array.isArray(review.checked_views)
    && requiredViews.every(view=>review.checked_views.includes(view))
    && Array.isArray(review.discrepancies) && review.discrepancies.length===0;
}

export async function runPerspectiveWorkflow({candidateId, name, idea, conceptPath, maxAttempts=3, resume=false, rerender=false,
  engine='sam3', tileSize=512, datasetRoot, outputRoot}, overrides={}) {
  if (!safeName(candidateId) || !safeName(name) || typeof idea!=='string' || !idea.trim()) throw new Error('agent needs a safe candidate, name and --idea');
  if (!Number.isInteger(maxAttempts) || maxAttempts<1 || maxAttempts>5) throw new Error('max attempts must be 1..5');
  if (rerender && !resume) throw new Error('RERENDER_REQUIRES_RESUME');
  const prepared = await (overrides.prepare ?? prepareFacadeContext)({candidateId,datasetRoot,outputRoot});
  const {runDir,candidate,context} = prepared;
  const jobDir = join(runDir, `${name}.agent`);
  if (!resume) await mkdir(jobDir); // Existing jobs require explicit resume.
  const manifestPath = join(jobDir,'workflow.json');
  const massPath = join(runDir,'selected.glb');
  const reference = join(runDir,'evidence','color','axon.png');
  const sourceName = `concept-${name}.png`;
  const sourcePath = join(jobDir,sourceName);
  const state = resume ? JSON.parse(await readFile(manifestPath,'utf8')) : {schema_version:'arr.elevation3d.perspective-workflow.v1',prompt_revision:WORKFLOW_PROMPT_REVISION,
    candidate:candidateId,idea,ok:false,stage:'prepared',mass_sha256:hash(await readFile(massPath)),attempts:[],receipts:[]};
  if (resume && (!['needs_correction','failed','interrupted'].includes(state.stage) || state.candidate!==candidateId || conceptPath))
    throw new Error('RESUME_NOT_ALLOWED: resume a stopped job without replacing its concept');
  async function stage(value, details={}) {
    Object.assign(state,{stage:value},details); await save(manifestPath,state);
    process.stderr.write(`[Facade agent] ${value}\n`);
  }
  async function unchanged() {
    if (hash(await readFile(massPath))!==state.mass_sha256 || hash(await readFile(sourcePath))!==state.source_sha256)
      throw new Error('WORKFLOW_AUTHORITY_CHANGED: mass or generated perspective changed during the run');
  }
  const task = overrides.task ?? runCodexTask;
  try {
    if (resume) {
      await unchanged();
      state.resumptions ??= [];
      state.resumptions.push({previous_stage:state.stage,previous_prompt_revision:state.prompt_revision,prompt_revision:WORKFLOW_PROMPT_REVISION});
      state.prompt_revision=WORKFLOW_PROMPT_REVISION;
      delete state.error;
    }
    const brief = await (overrides.brief ?? writeFacadeBrief)({runDir:jobDir,context});
    const schema = JSON.parse(await readFile(brief.paths.schema,'utf8'));
    const summary = JSON.parse(await readFile(brief.paths.context,'utf8'));
    let observation, vision;
    const obsPath = join(jobDir,'observation.json');
    const visPath = join(jobDir,'vision.json');
    const hasObs = await readFile(obsPath,'utf8').then(v=>JSON.parse(v), ()=>null);
    const hasVis = await readFile(visPath,'utf8').then(v=>JSON.parse(v), ()=>null);
    const hasSource = await readFile(sourcePath).then(()=>true, ()=>false);

    if (resume && hasObs && hasVis) {
      observation = hasObs;
      vision = hasVis;
      state.vision=vision;
      state.vision_ok=Boolean(vision?.ok);
      if (state.observation_sha256 && hash(Buffer.from(JSON.stringify(observation)))!==state.observation_sha256) throw new Error('OBSERVATION_CHANGED');
      if (state.vision_sha256 && hash(Buffer.from(JSON.stringify(vision)))!==state.vision_sha256) throw new Error('VISION_EVIDENCE_CHANGED');
    } else {
      if (!resume || !hasSource) {
        await stage('generating');
        if (conceptPath) {
          await copyFile(resolve(conceptPath),sourcePath);
          state.generation = {origin:'explicit_existing_concept',path:resolve(conceptPath)};
        } else {
          const subject = buildConceptSubject({context,idea});
          state.generation = await (overrides.generate ?? codexPhoto)({inputPng:reference,outputPng:sourcePath,subject,mode:'concept'});
          if (!state.generation.bound) throw new Error('UNBOUND_GENERATED_IMAGE: no invocation identity');
        }
        state.source_sha256 = hash(await readFile(sourcePath));
        state.source = sourcePath;
      } else {
        state.source_sha256 = hash(await readFile(sourcePath));
        state.source = sourcePath;
      }
      const {width,height} = await sharp(sourcePath).metadata();
      if (resume && hasObs) {
        observation = hasObs;
      } else {
        await stage('observing');
        const observed = await task({directory:join(jobDir,'observer'),name:'observation',images:[sourcePath,reference],
          prompt:observationPrompt({context:summary,width,height,sourceHash:state.source_sha256})});
        observation = observed.value;
        state.observation_sha256=hash(Buffer.from(JSON.stringify(observation)));
        state.receipts.push(observed.receipt);
        await save(obsPath,observation);
      }
      if (observation.mass_matches!==true) return await stage('concept_rejected',{observation}), {...state,manifest:manifestPath};
      if (!Array.isArray(observation.features) || !observation.features.length || !Array.isArray(observation.roi_px)) throw new Error('INVALID_OBSERVATION');
      const roiPath = join(jobDir,'observation-roi.json');
      await save(roiPath,{polygon_px:observation.roi_px,width_m:1,height_m:1,image_sha256:state.source_sha256,
        scale_note:'Normalized perspective observations only; not an orthographic drawing or a surveyed metric scale.'});
      if (resume && hasVis) {
        vision = hasVis;
      } else {
        await stage('segmenting');
        try {
          vision = await (overrides.trace ?? traceFacade)({candidateId,imagePath:sourcePath,name:`${name}-observations`,
            flags:{roi:roiPath,engine,'tile-size':String(tileSize),prompt:observation.segmentation_prompt || 'opening . hole',output:outputRoot}});
        } catch (error) {
          // Preserve the failure as evidence; never claim a different model was run.
          vision = {ok:false,engine,error:String(error.message),requires_semantic_review:true};
        }
        if (vision.out_dir) {
          const primitives=JSON.parse(await readFile(join(vision.out_dir,'facade_primitives.json'),'utf8'));
          vision.observations=summarizeVisionEvidence(primitives);
        }
        state.vision=vision;
        state.vision_ok=Boolean(vision?.ok);
        state.vision_sha256=hash(Buffer.from(JSON.stringify(vision)));
        await save(visPath,vision);
      }
    }
    const images=[sourcePath];
    if (vision.segmented_overlay) images.push(vision.segmented_overlay);
    let previous=null, feedback=null;
    if (resume && state.attempts.length) {
      const last=state.attempts.at(-1);
      previous=JSON.parse(await readFile(join(jobDir,`attempt-${last.attempt}`,'transcription.json'),'utf8')
        .catch(()=>readFile(join(jobDir,`attempt-${last.attempt}`,'transcriber','transcription.json'),'utf8')));
      feedback=last.feedback ?? {visual_review:last.review,source_comparison:last.source_comparison,unrepresented_features:previous.unrepresented_features};
    }
    const firstAttempt=Math.max(state.current_attempt ?? 0,...state.attempts.map(a=>a.attempt),0)+1;
    for (let attempt=firstAttempt; attempt<firstAttempt+maxAttempts; attempt++) {
      await unchanged();
      const attemptDir=join(jobDir,`attempt-${attempt}`);
      await mkdir(attemptDir);
      await stage('transcribing',{current_attempt:attempt});
      const authored=rerender && attempt===firstAttempt && previous
        ? {value:previous,receipt:{origin:'previous_transcription',source_attempt:state.attempts.at(-1).attempt}}
        : await task({directory:join(attemptDir,'transcriber'),images,name:'transcription',
          prompt:transcriptionPrompt({brief:brief.prompt,schema,sourceName,sourceHash:state.source_sha256,observation,vision,previous,feedback})});
      state.receipts.push(authored.receipt);
      previous=authored.value;
      await save(join(attemptDir,'transcription.json'),previous);
      const entry={attempt,stage:'transcribed'};
      state.attempts.push(entry);
      try { validateTranscription(previous,{sourceName,observation}); }
      catch(error){feedback={stage:'source_contract',error:error.message}; Object.assign(entry,feedback); continue;}
      const grammar=previous.grammar;
      await save(join(attemptDir,'grammar.json'),grammar);
      const resolvedGrammar = await inlineLatticeInstances(grammar, attemptDir).catch(() => grammar);
      const checked=(overrides.check ?? checkFacadeGrammar)({context,grammar:resolvedGrammar});
      if (!checked.ok) {
        const {program,resolved,validation,...report}=checked;
        feedback=report; Object.assign(entry,{stage:'grammar_rejected',feedback}); continue;
      }
      await stage('drawing');
      let drawn;
      try { drawn=await (overrides.draw ?? renderFacadeScheme)({runDir:join(attemptDir,'drawing'),candidate,context,grammar:resolvedGrammar,palette:'competition-material'}); }
      catch(error){feedback={stage:'render',error:error.message}; Object.assign(entry,{stage:'render_rejected',feedback}); continue;}
      if (!REQUIRED_DRAWING_VIEWS.every(view=>drawn.technical?.views?.[view]?.path)) {
        feedback={stage:'render',error:'DRAWING_VIEWS_INCOMPLETE: four elevations, plan, roof plan and two axons are required'};
        Object.assign(entry,{stage:'render_rejected',feedback}); continue;
      }
      await unchanged();
      const sourceComparison=await (overrides.compare ?? compareDrawingToSource)({runDir:jobDir,grammar,heroPath:drawn.hero.path});
      const views=Object.fromEntries(Object.entries(drawn.technical.views).map(([key,view])=>[key,resolve(attemptDir,'drawing','technical-render',view.path)]));
      views.hero=drawn.hero.path;
      entry.views=views; entry.compiled=drawn.compiled.output.path; entry.source_comparison=sourceComparison;
      entry.artifacts=Object.fromEntries(await Promise.all(Object.entries({...views,compiled:entry.compiled})
        .map(async([name,path])=>[name,{path,sha256:hash(await readFile(path))}])));
      await stage('reviewing');
      const reviewed=await task({directory:join(attemptDir,'reviewer'),name:'review',
        images:[sourcePath,...Object.values(views)],prompt:reviewPrompt({sourceHash:state.source_sha256,
          photographedFaces:observation.photographed_faces,imageLabels:['concept',...Object.keys(views)]})});
      state.receipts.push(reviewed.receipt);
      entry.review=reviewed.value;
      const requireVision = overrides.requireVision ?? false;
      const visionOk = state.vision?.ok !== false;
      const accepted=validateVisualReview(reviewed.value,Object.keys(views)) && sourceComparison.source_fidelity?.accepted===true
        && sourceComparison.source_fidelity?.checked===true
        && previous.unrepresented_features.length===0
        && (!requireVision || visionOk);
      Object.assign(entry,{stage:accepted?'accepted':'visual_rejected',vision_ok:visionOk});
      if (accepted) {
        await unchanged();
        await stage('accepted',{ok:true,views,compiled:entry.compiled,vision_ok:visionOk});
        return {...state,manifest:manifestPath,vision_ok:visionOk};
      }
      feedback={visual_review:reviewed.value,source_comparison:sourceComparison,unrepresented_features:previous.unrepresented_features};
      entry.feedback=feedback;
    }
    await stage('needs_correction');
    return {...state,manifest:manifestPath};
  } catch(error) {
    await stage('failed',{error:String(error.message)});
    throw error;
  }
}
