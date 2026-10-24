// Search categories. Obsidian's directory has no categories, so these are a plain keyword map over a plugin's
// name + description. It is a navigation aid, not a taxonomy: a plugin gets up to `max` categories, those with the
// most keyword hits first. Documented on the Methodology page.
export const CATEGORIES = [
  ['tasks', 'Tasks & habits', /\b(task|todo|to-do|kanban|checklist|reminder|gtd|habit|pomodoro|project)s?\b/gi],
  ['calendar', 'Calendar & journaling', /\b(calendar|daily|weekly|periodic|journal|diary|timeline|agenda)\b/gi],
  ['sync', 'Sync & backup', /\b(sync|backup|git|github|version|webdav|s3|dropbox|onedrive|icloud|cloud)\b/gi],
  ['publish', 'Publishing & sharing', /\b(publish|blog|website|static site|wordpress|hugo|jekyll|share|sharing|digital garden)\b/gi],
  ['ai', 'AI', /\b(ai|gpt|llm|chatgpt|openai|claude|gemini|ollama|copilot|embedding|semantic|assistant|chat)\b/gi],
  ['data', 'Data & properties', /\b(table|database|dataview|query|queries|csv|spreadsheet|bases|properties|property|frontmatter|yaml|metadata)\b/gi],
  ['graphs', 'Graphs & diagrams', /\b(graph|mind ?map|diagram|mermaid|chart|visuali[sz]\w*|plot|flowchart)\b/gi],
  ['drawing', 'Canvas & drawing', /\b(canvas|draw\w*|excalidraw|sketch|whiteboard|handwrit\w*|ink)\b/gi],
  ['editing', 'Editing & writing', /\b(editor|editing|vim|heading|toolbar|typewriter|spell\w*|grammar|autocomplete|autocompletion|writing|typography|formatting)\b/gi],
  ['io', 'Import & export', /\b(import|export|convert\w*|docx|epub|html|anki|notion|evernote|readwise|clipper|clip)\b/gi],
  ['nav', 'Search, links & navigation', /\b(search|navigat\w*|jump|switcher|outline|tabs?|bookmark\w*|breadcrumb\w*|backlinks?|tags?|links?)\b/gi],
  ['automation', 'Templates & automation', /\b(template\w*|boilerplate|snippet\w*|macro\w*|script\w*|automat\w*|workflow\w*|commands?)\b/gi],
  ['research', 'Research & citations', /\b(citation\w*|zotero|bibtex|reference\w*|academic|paper|research|latex|math|footnote\w*|bibliography)\b/gi],
  ['media', 'Media', /\b(image\w*|audio|video|pdf|media|photo\w*|screenshot\w*|youtube|podcast\w*|speech|voice|transcri\w*)\b/gi],
  ['appearance', 'Appearance', /\b(theme\w*|css|style\w*|font\w*|colou?r\w*|icon\w*|appearance|dark mode|banner\w*|cover)\b/gi],
  ['files', 'Files & vault', /\b(file|files|folder\w*|rename\w*|attachment\w*|vault|explorer|organi[sz]\w*)\b/gi],
  ['integrations', 'Integrations', /\b(jira|todoist|slack|discord|telegram|google|api|webhook\w*|rss|twitter|mastodon|email|zapier|trello)\b/gi],
  ['stats', 'Stats & goals', /\b(word count|statistic\w*|stats|reading time|analytics|progress|goal\w*|streak\w*)\b/gi],
  ['mobile', 'Mobile', /\b(mobile|ios|android|phone|tablet|iphone|ipad)\b/gi],
  ['games', 'Games & fun', /\b(game\w*|rpg|dice|ttrpg|d&d|fun)\b/gi],
];

export const categoryLabel = Object.fromEntries(CATEGORIES.map(([id, label]) => [id, label]));

/** Category ids for a plugin, best first. Deterministic: ties follow the order of CATEGORIES. */
export function categorize(plugin, max = 3) {
  const text = `${plugin.name ?? ''} ${plugin.description ?? ''}`;
  return CATEGORIES.map(([id, , re], i) => ({ id, i, hits: (text.match(re) ?? []).length }))
    .filter((c) => c.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.i - b.i)
    .slice(0, max)
    .map((c) => c.id);
}
