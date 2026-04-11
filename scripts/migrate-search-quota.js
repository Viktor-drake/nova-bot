#!/usr/bin/env node
// Добавляет поля searches_month и searches_month_key в participants DB
// Запуск: node scripts/migrate-search-quota.js

const fs = require('fs')
const path = require('path')

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\r\n]*)"?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}
loadEnv()

const { Client } = require('@notionhq/client')
const notion = new Client({ auth: process.env.NOTION_TOKEN })
const DB_PARTICIPANTS = 'b056e256-a4c5-4aa5-8569-abdca291c2a3'

async function main() {
  console.log('→ Добавляем поля в participants DB...')

  try {
    await notion.databases.update({
      database_id: DB_PARTICIPANTS,
      properties: {
        searches_month: {
          type: 'number',
          number: { format: 'number' },
        },
        searches_month_key: {
          type: 'rich_text',
          rich_text: {},
        },
      },
    })
    console.log('✅ Поля добавлены: searches_month, searches_month_key')
  } catch (e) {
    if (e.message?.includes('already exists')) {
      console.log('ℹ️  Поля уже существуют, пропускаем')
    } else {
      console.error('❌ Ошибка:', e.message)
      process.exit(1)
    }
  }

  console.log('\n✨ Миграция завершена')
}

main()
