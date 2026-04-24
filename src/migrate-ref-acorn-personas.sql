-- Add the agentic-planning persona attribute to ref-acorn-context.mode
-- so the agent's graph_query for "plan mode" surfaces the delegate_task
-- pattern. Idempotent: WHERE NOT EXISTS guards re-running.

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'mode'),
       'For non-trivial plans, delegate parallel research with delegate_task({persona: "researcher", task: "..."}). The researcher persona has only web_search + web_fetch and returns a structured Findings/Caveats/Recommendation summary. Fan out 1-3 researchers per plan, wait for results, splice findings into the plan. Codebase reading stays in your own turns — sub-agents have no CLI bridge to the user''s files.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'mode' AND a.content LIKE 'For non-trivial plans, delegate parallel research%');
