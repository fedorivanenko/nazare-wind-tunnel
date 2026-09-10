import {defineAgent} from 'eve';

export default defineAgent({
  model:'openai/gpt-oss-120b',
  reasoning:'low',
  defaultTools:false,
  limits:{
    maxInputTokensPerSession:200_000,
    maxOutputTokensPerSession:20_000,
    maxTokenCostUsdPerSession:2,
    sessionTimeoutMs:15*60*1_000,
  },
});
