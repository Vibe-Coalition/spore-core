DELETE FROM attributes
WHERE aspect_id IN (
  SELECT id FROM aspects
  WHERE node_id='ref-browser-automation' AND extracted_with='playwright'
);

DELETE FROM aspects
WHERE node_id='ref-browser-automation' AND extracted_with='playwright';
