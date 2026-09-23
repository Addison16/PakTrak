.PHONY: setup dev test test-e2e test-accounts test-recovery migrate import-catalog logs stop
setup:
	sh scripts/setup.sh
dev:
	sh scripts/start.sh
test:
	sh scripts/test.sh
test-e2e:
	sh scripts/test-browser.sh
test-accounts:
	sh scripts/test-accounts-browser.sh
test-recovery:
	sh scripts/test-recovery.sh
migrate:
	docker compose run --rm migrate
import-catalog:
	docker compose exec -T api python -m scanner.catalog --download default_cards
logs:
	docker compose logs -f --tail 50 api worker transfer-worker dispatcher
stop:
	docker compose down
