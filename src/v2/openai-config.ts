import { z } from 'zod';

// Rates are integer tenths of a micro-dollar per token ($/1M tokens × 10).
export const priceCardSchema=z.object({
  id:z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
  input:z.number().int().nonnegative(),cached:z.number().int().nonnegative(),
  cache_write:z.number().int().nonnegative(),output:z.number().int().positive(),
}).strict();
export type PriceCard=z.infer<typeof priceCardSchema>;
export const SOL_PRICE:PriceCard={id:'gpt-6.1-sol-standard-2026-10-15',input:20,cached:1,cache_write:25,output:100};
export type OpenAiConfig={model:string;reasoning:'low'|'medium'|'high'|'xhigh'|'max';maxInputTokens:number;maxOutputTokens:number;price:PriceCard};
const integer=(env:NodeJS.ProcessEnv,name:string,fallback:number,max:number)=>z.coerce.number().int().min(1).max(max).parse(env[name]??fallback);
export function readOpenAiConfig(env:NodeJS.ProcessEnv):OpenAiConfig {
  const model=z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/).parse(env.GM_MODEL??'gpt-6.1-sol');
  // Changing models must not accidentally keep the previous model's prices.
  const price=env.GM_PRICE_CARD_JSON?priceCardSchema.parse(JSON.parse(env.GM_PRICE_CARD_JSON)):
    model==='gpt-6.1-sol'?SOL_PRICE:null;
  if(!price)throw new Error('GM_PRICE_CARD_JSON is required for a different model');
  return {model,price,reasoning:z.enum(['low','medium','high','xhigh','max']).parse(env.GM_REASONING_EFFORT??'medium'),
    maxInputTokens:integer(env,'GM_MAX_INPUT_TOKENS',16384,64000),maxOutputTokens:integer(env,'GM_MAX_OUTPUT_TOKENS',2048,16000)};
}
export function costMicroUsd(price:PriceCard,input:number,cached:number,writes:number,output:number):number {
  const total=BigInt(input-cached-writes)*BigInt(price.input)+BigInt(cached)*BigInt(price.cached)+BigInt(writes)*BigInt(price.cache_write)+BigInt(output)*BigInt(price.output);
  const cost=(total+9n)/10n;
  if(cost<0n || cost>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Invalid cost');
  return Number(cost);
}
export function reservation(config:OpenAiConfig):number {
  const worst={...config.price,input:Math.max(config.price.input,config.price.cached,config.price.cache_write)};
  return costMicroUsd(worst,config.maxInputTokens,0,0,config.maxOutputTokens);
}
