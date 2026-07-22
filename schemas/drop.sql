-- Clear all app data (keeps tables, functions, indexes)
truncate table
  provider_case_offer_messages,
  payments,
  cases,
  provider_case_offer_batches,
  provider_signup_requests,
  user_goal_values,
  documents,
  providers,
  goal_definitions
restart identity cascade;

-- Clear LangGraph agent thread memory (created by PostgresSaver on first run)
truncate table
  checkpoint_writes,
  checkpoint_blobs,
  checkpoints
restart identity cascade;
