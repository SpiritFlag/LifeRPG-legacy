import { performance } from 'node:perf_hooks';
import { OpenAiGm } from './openai-gm.ts';
import type { GmAdapter } from './worker.ts';
import { safeProviderError } from './openai-errors.ts';
import type { SafeProviderError } from './openai-errors.ts';

export type SyntheticMeasurement={operation_id:string;kind:string;elapsed_ms:number;http_elapsed_ms:number|null;
  api_requests:number;http_status:number|null;error_code:string|null;provider_error:SafeProviderError|null};

/** Measure the actual transport boundary; receipts use operation_id, never an input request_id. */
export function measureSyntheticGm(gm:OpenAiGm,emit:(sample:SyntheticMeasurement)=>void):GmAdapter {
  return {provider:gm.provider,model:gm.model,maxCost:gm.maxCost,priceCard:gm.priceCard,
    fitsContext:context=>gm.fitsContext(context),
    async generate(context,signal) {
      const started=performance.now();let requests=0,status:number|null=null,httpMs:number|null=null,error:string|null=null;
      let diagnostic:SafeProviderError|null=null;
      const measured=new OpenAiGm(gm.config,async(body,abort)=>{
        const sent=performance.now();requests++;
        try {const response=await gm.transport(body,abort);status=response.status;return response;}
        finally {httpMs=Math.round(performance.now()-sent);}
      });
      try {
        const reply=await measured.generate(context,signal);error=reply.failure?.code??null;
        if(reply.failure?.provider_error)diagnostic=safeProviderError(reply.failure.provider_error);
        return reply;
      } catch {error='measurement_call_failed';throw new Error(error);}
      finally {
        // Telemetry must never interrupt adjudication or create another API request.
        try {emit({operation_id:context.operation_id,kind:context.kind,elapsed_ms:Math.round(performance.now()-started),
          http_elapsed_ms:httpMs,api_requests:requests,http_status:status,error_code:error,provider_error:diagnostic});} catch { /* Non-critical sink. */ }
      }
    },
  };
}
