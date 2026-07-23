// `pnpm env:schema` — печатает документ env-schema.1 в stdout (env-catalog item 4).
// Детерминированный JSON: 2 пробела, variables отсортированы по name, завершающий \n.
// Файл env-schema.json в репо НЕ коммитится — агрегатор control-center и CI-гейты
// захватывают stdout этой команды; запись в файл — только шелл-редиректом.
import { renderEnvSchemaJson } from '../src/config/env-schema.ts';

process.stdout.write(renderEnvSchemaJson());
