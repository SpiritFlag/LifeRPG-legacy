import type { GmAdapter, GmContext, GmReply } from './worker.ts';

/** Deliberately deterministic. Never imports an HTTP client, SDK, key or environment. */
export class MockGm implements GmAdapter {
  model='mock-v2' as const;
  maxCost=1;
  async generate(context:GmContext,signal:AbortSignal):Promise<GmReply> {
    signal.throwIfAborted();
    const clarify=context.kind==='observation' && Array.isArray(context.input.unknowns) && context.input.unknowns.length>0;
    const summary='[합성 GM] 서버가 처리한 테스트 결과입니다.';
    return {proposal:clarify?{outcome:'clarify',summary,question:'확인되지 않은 사실을 알려주세요.',xp_delta:0,memories:[]}:{
      outcome:context.kind==='appeal'?'no_change':'commit',summary,
      xp_delta:['observation','answer'].includes(context.kind)?5:0,
      memories:context.kind==='appeal'?[]:[{kind:context.kind==='start'?'identity':'episode',text:'[합성 기억] 전달받은 맥락을 참고했습니다.'}],
      operations:context.kind==='start'?[
        {op:'put',ref:'@village',expected_version:0,visibility:'public',private_notes:null,body:{kind:'place',name:'합성 마을',description:'검증용 시작 장소',parent:null}},
        {op:'put',ref:'@hero',expected_version:0,visibility:'public',private_notes:null,body:{kind:'character',name:'합성 모험가',description:'검증용 캐릭터',level:1,stats:[{name:'의지',value:1}],profession:null,location:'@village'}},
      ]:[],reward_source:null,scene:null,
    },usage:{input_tokens:0,output_tokens:0,cost:0}};
  }
}
