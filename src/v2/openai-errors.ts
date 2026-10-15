/** Only server-controlled categorical fields may survive an HTTP error. */
export type SafeProviderError={code:string|null;param:string|null;request_id:string|null};
const codes=new Set(['invalid_json_schema','invalid_request_error','invalid_value','invalid_type','invalid_parameter',
  'unsupported_parameter','unsupported_value','missing_required_parameter','invalid_api_key','insufficient_quota',
  'rate_limit_exceeded','server_error','model_not_found','context_length_exceeded']);
const params=new Set(['model','reasoning','reasoning.effort','max_output_tokens','input','instructions','store','stream',
  'service_tier','truncation','text','text.format','text.format.type','text.format.name','text.format.strict','text.format.schema']);

export function safeProviderError(value:unknown):SafeProviderError {
  const v=value&&typeof value==='object'?value as Record<string,unknown>:{};
  return {code:typeof v.code==='string'&&codes.has(v.code)?v.code:null,
    param:typeof v.param==='string'&&params.has(v.param)?v.param:null,
    // Unknown ID formats are dropped. Do not accept arbitrary strings merely because they are short.
    request_id:typeof v.request_id==='string'&&/^req_[a-f0-9]{32}$/.test(v.request_id)?v.request_id:null};
}

/** Bounded transient parsing; never return the body, message, headers, or arbitrary values. */
export async function readSafeProviderError(response:Response):Promise<SafeProviderError> {
  const base={request_id:response.headers.get('x-request-id')};
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')) {
    try {await response.body?.cancel();} catch { /* Preserve the original HTTP status. */ }
    return safeProviderError(base);
  }
  const reader=response.body?.getReader();if(!reader)return safeProviderError(base);
  try {
    const chunks:Uint8Array[]=[];let length=0;
    while(true) {
      const {value,done}=await reader.read();if(done)break;
      length+=value.byteLength;if(length>32768)return safeProviderError(base);
      chunks.push(value);
    }
    const parsed:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const error=parsed&&typeof parsed==='object'&&'error' in parsed?parsed.error:null;
    if(!error||typeof error!=='object')return safeProviderError(base);
    const e=error as Record<string,unknown>;
    return safeProviderError({code:e.code,param:e.param,...base});
  } catch {return safeProviderError(base);}
  finally {try {await reader.cancel();} catch { /* Never log parse/read exceptions. */ }reader.releaseLock();}
}
