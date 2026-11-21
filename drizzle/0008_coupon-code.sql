ALTER TABLE `products` ADD `coupon_code` text CONSTRAINT "products_coupon_code_length" CHECK("products"."coupon_code" IS NULL OR length("products"."coupon_code") <= 255);
