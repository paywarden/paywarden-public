-- Reserve every HD address that has appeared on an order. Earlier releases
-- returned addresses to the pool and could clear the allocated_to reference.
UPDATE "addresses" AS pool
SET
  "is_allocated" = true,
  "allocated_to" = CASE
    WHEN issued.order_count = 1 THEN issued.only_order_id
    ELSE pool."allocated_to"
  END
FROM (
  SELECT
    "address",
    count(*) AS order_count,
    min("id"::text)::uuid AS only_order_id
  FROM "orders"
  WHERE "derivation_idx" IS NOT NULL
  GROUP BY "address"
) AS issued
WHERE pool."address" = issued."address";
