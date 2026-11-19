// R67: the cards' own layout, on Clyde's design system (design.ts: tokens.css and components.css). Only --cl- tokens, no
// literal colors. Compact one-line rows by default (top three shown), expanding in place.
export const CARD_CSS = `[hidden]{display:none!important}
html,body{margin:0;padding:0;background:transparent}
body{color:var(--cl-ink);font:var(--cl-text-body);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
*,*::before,*::after{box-sizing:border-box}
button,input,textarea{font:inherit;color:inherit}
.clyde{background:var(--cl-paper-1);border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-lg);box-shadow:var(--cl-shadow-1);overflow:hidden;max-width:100%}
.c-head{display:flex;align-items:center;gap:var(--cl-space-2);padding:8px var(--cl-space-3);border-bottom:1px solid var(--cl-rule);min-width:0;--cl-logo-h:16px}
.c-head .cl-wordmark,.c-toggle,.c-fold{flex:none}
.c-what{flex:1;min-width:0;color:var(--cl-ink-3);font:var(--cl-text-small);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.c-head .cl-agent{flex:none;max-width:38%}
.c-toggle{height:24px;padding:0 8px;font-size:12px;gap:4px}
.c-toggle[aria-expanded=true] .c-i,.c-fold .c-i{transform:rotate(180deg)}
.c-desk{display:grid;gap:6px;padding:8px var(--cl-space-3);background:var(--cl-paper-0)}
.c-recall-scroll{max-height:420px;overflow-y:auto;overscroll-behavior-y:contain;scrollbar-gutter:stable}
@media (max-width:460px){.c-recall-scroll{max-height:340px}}
.c-desk>.cl-card:not(.cl-memory){padding:0}
.cl-memory.is-compact{padding:8px 12px;gap:0}
.cl-memory.is-compact:hover,.cl-quest.is-compact:hover{border-color:var(--cl-rule-strong)}
button.c-sum,button.c-qsum{appearance:none;display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:0;border:0;background:none;text-align:left;cursor:pointer}
button.c-qsum{padding:8px 12px}
button.c-sum:focus-visible,button.c-qsum:focus-visible{outline:none;box-shadow:var(--cl-focus);border-radius:var(--cl-radius-sm)}
.c-sum__title{flex:1;min-width:0;font:600 13.5px/19px var(--cl-font-sans);color:var(--cl-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cl-memory.is-superseded .c-sum__title{text-decoration:line-through;color:var(--cl-ink-3)}
.cl-quest.is-done .c-sum__title{color:var(--cl-ink-2)}
.c-sum .cl-memory__conf{margin-left:0;flex:none;color:var(--cl-ink-3);font-weight:500;white-space:nowrap}
.c-sum .cl-stamp,.c-qsum .cl-stamp{transform:none;padding:2px 6px 1px;font-size:10px;border-width:1.5px;flex:none}
.c-sum .c-i,.c-qsum .c-i{color:var(--cl-ink-3)}
.c-full{display:grid;gap:8px;min-width:0}
.cl-memory__top{flex-wrap:wrap;row-gap:6px}
.cl-memory__conf{white-space:nowrap}
.c-fold{height:22px;padding:0 6px;font-size:11.5px;gap:4px}
.cl-quest.is-compact{display:block}
.c-qno{flex:none;padding:2px 6px;border-radius:var(--cl-radius-xs);background:var(--cl-sticky);border:1px solid var(--cl-sticky-edge);font:700 11px/1.2 var(--cl-font-mono);color:var(--cl-ink)}
.cl-quest.is-done .c-qno{background:var(--cl-paper-2);border-color:var(--cl-rule-strong);color:var(--cl-ink-3)}
.c-more{justify-self:start;height:26px;padding:0 10px;font-size:12px}
.c-foot{display:flex;flex-wrap:wrap;align-items:center;gap:var(--cl-space-2);padding:10px var(--cl-space-3);border-top:1px solid var(--cl-rule)}
.c-foot .c-note{flex:1;min-width:150px;color:var(--cl-ink-3);font:var(--cl-text-small)}
.c-say{margin:0;padding:0 var(--cl-space-3) 10px;font:var(--cl-text-small)}
.c-say.is-ok{color:var(--cl-ok)}.c-say.is-bad{color:var(--cl-bad)}.c-say.is-muted{color:var(--cl-ink-3)}
.cl-memory__title,.cl-quest__title,.cl-memory__body,.cl-quest__brief,.c-text{overflow-wrap:anywhere}
.cl-memory__body.is-open{display:block;-webkit-line-clamp:unset;white-space:pre-wrap}
.c-text{margin:0;white-space:pre-wrap;font:var(--cl-text-small);color:var(--cl-ink-2)}
.c-quote{margin:0;padding:6px 10px;border-left:2px solid var(--cl-carbon);background:var(--cl-carbon-wash);color:var(--cl-carbon-ink);border-radius:0 var(--cl-radius-sm) var(--cl-radius-sm) 0;font:var(--cl-text-small);overflow-wrap:anywhere}
.c-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.c-row .c-sp{flex:1}
.c-art{appearance:none;display:inline-flex;align-items:center;gap:6px;max-width:100%;height:24px;padding:0 8px;border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-sm);background:var(--cl-paper-1);color:var(--cl-ink-2);font:var(--cl-text-mono);font-size:11.5px}
.c-art span,.c-links li span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button.c-art{cursor:pointer}button.c-art:hover{border-color:var(--cl-carbon);color:var(--cl-ink)}
button.c-art:focus-visible{outline:none;box-shadow:var(--cl-focus)}
.c-i{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.cl-btn.c-wrong[aria-pressed=true]{color:var(--cl-bad);border-color:var(--cl-bad);background:var(--cl-bad-wash);transform:none;box-shadow:none}
.cl-btn.c-used[aria-pressed=true]{color:var(--cl-ok);border-color:var(--cl-ok);background:var(--cl-ok-wash);transform:none;box-shadow:none}
.c-meter{width:32px;height:4px;border-radius:2px;background:var(--cl-paper-2);overflow:hidden;display:inline-block;vertical-align:middle;margin-right:6px}
.c-meter i{display:block;height:100%;background:var(--cl-ink-2)}
.c-detail{display:grid;gap:var(--cl-space-2);padding-top:var(--cl-space-2);border-top:1px dashed var(--cl-rule)}
.c-links{margin:0;padding:0;list-style:none;display:grid;gap:4px;font:var(--cl-text-small)}
.c-links li{display:flex;gap:6px;min-width:0;align-items:baseline}
.cl-file.is-compact .cl-file__head{border-bottom:0}
.cl-file pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto}
.c-img{display:block;max-width:100%;max-height:420px;margin:0 auto}
.c-hero{display:flex;flex-wrap:wrap;align-items:center;gap:var(--cl-space-2) var(--cl-space-3);padding:10px var(--cl-space-3)}
.c-hero .c-sub{color:var(--cl-ink-3);font:var(--cl-text-small)}
.cl-quest .c-row{margin-top:2px}
form.c-complete{display:grid;gap:var(--cl-space-2)}
form.c-complete .cl-textarea{min-height:72px}
.c-skel{height:12px;border-radius:6px;background:var(--cl-paper-2);margin:6px 0}
.c-big .cl-agent__sq{width:32px;height:32px;font-size:13px;border-width:2px}
.c-big .cl-agent__name{font:var(--cl-text-title-3)}
@media (max-width:460px){.c-head .cl-agent__meta,.c-sum .c-meter,.cl-memory__top .c-meter{display:none}.c-sum .cl-state{font-size:0;gap:0}.cl-quest:not(.is-compact){grid-template-columns:56px minmax(0,1fr)}.cl-quest__no{font-size:17px}}`;
