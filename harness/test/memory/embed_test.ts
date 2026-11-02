/**
 * Tier 3's unit tests of the memory function's own code, run with `deno test`, since they import it as deno does. No
 * database: postgres.js only connects on a first query. node --test skips this file, which isn't a *.test.ts.
 */
import assert from 'node:assert/strict'
import { entryText } from '../../../memory/supabase/functions/memory/embed.ts'

// R9 (#12): entryText of a private row is its title.
Deno.test('entryText sends a private or confidential entry to OpenAI by its title alone', () => {
  const row = {
    title: 'Buys oolong from a private supplier', body: 'Supplier name and pricing.', evidence: 'my supplier is secret co',
    search_text: 'Buys oolong from a private supplier\nSupplier name and pricing.\nmy supplier is secret co',
  }
  assert.equal(entryText({ ...row, sensitivity: 'private' }), row.title)
  assert.equal(entryText({ ...row, sensitivity: 'confidential' }), row.title)
  assert.equal(entryText({ ...row, sensitivity: 'normal' }), row.search_text)
})
