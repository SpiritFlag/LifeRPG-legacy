import { readOpenAiConfig,reservation } from './openai-config.ts';
import { GM_OUTPUT_SCHEMA } from './openai-gm.ts';
import { assertStructuredSchema } from './openai-schema.ts';
import { operatingMonthlyBudget } from './budget.ts';

// Read-only configuration/schema check. No key access, transport or database instance.
try {
  const config=readOpenAiConfig(process.env),cost=reservation(config),monthly=operatingMonthlyBudget(process.env);
  console.info(JSON.stringify({mode:'offline_preflight',schema:assertStructuredSchema(GM_OUTPUT_SCHEMA),
    model:config.model,reasoning:config.reasoning,max_input_tokens:config.maxInputTokens,max_output_tokens:config.maxOutputTokens,
    price_card:config.price,reservation_micro_usd:cost,operating_monthly_budget_micro_usd:monthly,
    monthly_can_fit_one_reservation:cost<=monthly,empty_month_worst_case_calls:Math.floor(monthly/cost),
    budget_applied:false,ledger_checked:false,paid_calls_authorized:false},null,2));
} catch {
  console.error('Offline GM preflight failed: invalid configuration or unsupported schema. No API request or DB access.');
  process.exitCode=1;
}
