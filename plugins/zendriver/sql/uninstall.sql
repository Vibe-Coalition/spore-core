-- zendriver uninstall — drop our aspect on the shared
-- ref-browser-automation node. browser-core's other aspects are
-- untouched (extracted_with='browser-core').

DELETE FROM attributes
WHERE aspect_id IN (
  SELECT id FROM aspects
  WHERE node_id='ref-browser-automation' AND extracted_with='zendriver'
);

DELETE FROM aspects
WHERE node_id='ref-browser-automation' AND extracted_with='zendriver';
