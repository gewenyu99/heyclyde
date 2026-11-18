/** Gate criteria come from the skills: the bold lead-in bullets under a section of skills/<skill>/SKILL.md. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../config.ts'

export function skillPath(skill: string, root = repoRoot()): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skill)) throw new Error(`skill ${skill} must be a skill directory name like code-it-works`)
  return join(root, 'skills', skill, 'SKILL.md')
}

/** "- **Red then green.** The end condition failed..." becomes "Red then green. The end condition failed...". */
export function gate(skill: string, section = 'Pass the gate', root = repoRoot()): string[] {
  let text: string
  try {
    text = readFileSync(skillPath(skill, root), 'utf8')
  } catch {
    throw new Error(`skill ${skill} has no SKILL.md at ${skillPath(skill, root)}`)
  }
  const criteria = bullets(sectionLines(text, section))
  if (!criteria.length) throw new Error(`skill ${skill} has no bold bullets under "## ${section}"`)
  return criteria
}

function sectionLines(text: string, section: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${section}`)
  if (start < 0) return []
  const end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l))
  return lines.slice(start + 1, end < 0 ? undefined : end)
}

/** A bullet runs until a blank line or the next bullet, so a wrapped bullet stays one criterion. */
function bullets(lines: string[]): string[] {
  const out: string[] = []
  let current: string[] | null = null
  const flush = () => {
    if (current) out.push(current.join(' '))
    current = null
  }
  for (const line of lines) {
    const lead = line.match(/^[-*] \*\*(.+?)\*\*\s*(.*)$/)
    if (lead) {
      flush()
      current = [lead[1].trim(), lead[2].trim()].filter(Boolean)
    } else if (current && line.trim() && /^\s/.test(line)) current.push(line.trim())
    else flush()
  }
  flush()
  return out
}
