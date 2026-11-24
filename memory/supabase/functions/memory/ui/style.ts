// R67: the cards' own layout, on Clyde's design system (design.ts: tokens.css and components.css). Only --cl- tokens, no
// literal colors. Flat hairline-divided rows inside one outer sheet; slim single-row header; inline expansion in place.
export const CARD_CSS = `[hidden]{display:none!important}
html,body{margin:0;padding:0;background:transparent}
body{color:var(--cl-ink);font:var(--cl-text-body);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
*,*::before,*::after{box-sizing:border-box}
button,input,textarea{font:inherit;color:inherit}
.clyde{background:var(--cl-paper-1);border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-lg);overflow:hidden;max-width:100%}
.c-head{display:flex;align-items:center;gap:var(--cl-space-2);min-height:34px;padding:7px 12px;border-bottom:1px solid var(--cl-rule);min-width:0;--cl-logo-h:14px}
.c-head .cl-wordmark,.c-toggle,.c-fold,.c-ext{flex:none}
.c-what{flex:1;min-width:0;display:flex;align-items:center;gap:6px;color:var(--cl-ink-3);font:var(--cl-text-small);overflow:hidden}
.c-what__txt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.c-head-chip{display:inline-block;flex:0 1 auto;min-width:0;max-width:160px;line-height:20px;overflow:hidden;text-overflow:ellipsis}
.c-saved{display:inline-flex;align-items:center;gap:5px;color:var(--cl-ok);font:600 12px/1 var(--cl-font-sans);white-space:nowrap;flex:none}
.c-saved::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--cl-ok);flex:none}
.c-toggle{min-height:28px;min-width:28px;height:auto;padding:4px 6px;font-size:12px;gap:0;color:var(--cl-ink-3)}
.c-fold{min-height:28px;min-width:28px;height:auto;padding:4px 6px;font-size:12px;gap:0;color:var(--cl-ink-3)}
.c-toggle:hover,.c-fold:hover,.c-ext:hover,.c-open:hover{color:var(--cl-ink)}
.c-toggle[aria-expanded=true] .c-i,.c-fold .c-i,.c-more[aria-expanded=true] .c-i,.c-fold-art[aria-expanded=true] .c-i{transform:rotate(180deg)}
.c-ext,.c-open,.c-claim,.c-complete-btn{min-height:28px;height:auto;padding:3px 8px;font-size:12px;gap:4px}
.c-ext,.c-open{color:var(--cl-ink-2)}
.c-desk{display:grid;gap:0;padding:0;background:transparent}
.c-recall-scroll{max-height:380px;overflow-y:auto;overscroll-behavior-y:contain}
@media (max-width:460px){.c-recall-scroll{max-height:320px}}
.c-desk>article+article{border-top:1px solid var(--cl-rule)}
.cl-memory{display:grid;gap:5px;padding:10px 12px;min-width:0}
.cl-memory.is-compact{padding:8px 12px;gap:0}
.cl-memory.is-compact:hover,.cl-quest.is-compact:hover,.c-desk>.cl-file.is-compact:hover{background:var(--cl-paper-0)}
button.c-sum,button.c-qsum{appearance:none;display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:0;border:0;background:none;text-align:left;cursor:pointer}
button.c-qsum,.c-desk>.cl-file.is-compact button.c-sum,button.c-agent-sum{padding:8px 12px}
button.c-sum:focus-visible,button.c-qsum:focus-visible,.c-toggle:focus-visible,.c-fold:focus-visible,.c-more:focus-visible,.c-open:focus-visible,.c-ext:focus-visible,.c-body-more:focus-visible{outline:none;box-shadow:var(--cl-focus);border-radius:var(--cl-radius-sm)}
.c-toggle,.c-fold,.c-more,.c-open,.c-ext,.c-claim,.c-complete-btn,.c-body-more,button.c-sum,button.c-qsum{touch-action:manipulation}
.c-sum__title{flex:1;min-width:0;font:600 13.5px/19px var(--cl-font-sans);color:var(--cl-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cl-memory.is-superseded .c-sum__title{text-decoration:line-through;color:var(--cl-ink-3)}
.cl-quest.is-done .c-sum__title{color:var(--cl-ink-2)}
.c-sum .cl-memory__conf{margin-left:0;flex:none;color:var(--cl-ink-3);font-weight:500;white-space:nowrap}
.c-sum .c-i,.c-qsum .c-i{color:var(--cl-ink-3);flex:none}
.c-sep{color:var(--cl-ink-3);font-size:12px;flex:none}
.c-full{display:grid;gap:5px;min-width:0}
.cl-memory__top{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0}
.cl-memory__title{flex:1 1 180px;min-width:0;font:600 14px/19px var(--cl-font-sans);letter-spacing:-0.01em;color:var(--cl-ink);margin:0;text-wrap:pretty;overflow-wrap:anywhere}
.c-mem-actions{display:inline-flex;align-items:center;gap:6px;margin-left:auto;flex:none;flex-wrap:wrap;max-width:100%}
.cl-memory__conf{margin-left:0;font:600 11.5px/1 var(--cl-font-mono);color:var(--cl-ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.cl-memory__body{font:var(--cl-text-small);color:var(--cl-ink-2);margin:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.cl-memory__body.c-clamp4{-webkit-line-clamp:4}
.cl-memory__body.is-open{display:block;-webkit-line-clamp:unset;white-space:pre-wrap}
.c-body-more{appearance:none;border:0;background:none;padding:2px 0;justify-self:start;color:var(--cl-carbon);font:500 12px/1.2 var(--cl-font-sans);cursor:pointer}
.c-body-more:hover{text-decoration:underline;text-underline-offset:2px}
.c-code{font-family:var(--cl-font-mono);font-size:0.88em;padding:1px 4px;border-radius:var(--cl-radius-xs);background:var(--cl-paper-2);color:var(--cl-ink)}
.cl-quest__done .c-code{background:var(--cl-paper-1)}
.cl-memory.is-superseded .c-code{color:var(--cl-ink-3);text-decoration:line-through}
.c-more{justify-self:start;min-height:28px;height:auto;width:100%;border:0;border-top:1px solid var(--cl-rule);border-radius:0;padding:7px 12px;font-size:12px;justify-content:flex-start;color:var(--cl-ink-2)}
.c-more:hover{border-top-color:var(--cl-rule)}
.c-foot{display:flex;flex-wrap:wrap;align-items:center;gap:var(--cl-space-2);padding:8px 12px;border-top:1px solid var(--cl-rule)}
.c-foot .c-say{padding:0}
.c-say{margin:0;padding:0 12px 8px;font:var(--cl-text-small)}
.c-say.is-bin-note{padding:10px 12px}
.c-say.is-ok{color:var(--cl-ok)}.c-say.is-bad{color:var(--cl-bad)}.c-say.is-muted{color:var(--cl-ink-3)}
.c-text{margin:0;white-space:pre-wrap;font:var(--cl-text-small);color:var(--cl-ink-2);overflow-wrap:anywhere}
.c-quote{margin:0;padding:5px 9px;border-left:2px solid var(--cl-carbon);background:var(--cl-carbon-wash);color:var(--cl-carbon-ink);border-radius:0 var(--cl-radius-sm) var(--cl-radius-sm) 0;font:var(--cl-text-small);overflow-wrap:anywhere}
.c-meta-foot{display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px;font:var(--cl-text-mono);font-size:11px;line-height:16px;color:var(--cl-ink-3);min-width:0;overflow-wrap:anywhere}
.c-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.c-row .c-sp{flex:1}
.c-art{appearance:none;display:inline-flex;align-items:center;gap:6px;max-width:100%;min-height:28px;height:auto;padding:3px 8px;border:1px solid var(--cl-rule-strong);border-radius:var(--cl-radius-sm);background:var(--cl-paper-1);color:var(--cl-ink-2);font:var(--cl-text-mono);font-size:11.5px;touch-action:manipulation}
.c-art span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button.c-art{cursor:pointer}button.c-art:hover{border-color:var(--cl-carbon);color:var(--cl-ink)}
button.c-art:focus-visible{outline:none;box-shadow:var(--cl-focus)}
.cl-file__head .c-row>span{min-width:0;overflow-wrap:anywhere}
.c-i{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.cl-btn.c-wrong[aria-pressed=true]{color:var(--cl-bad);border-color:var(--cl-bad);background:var(--cl-bad-wash);transform:none;box-shadow:none;opacity:1}
.cl-btn.c-used[aria-pressed=true]{color:var(--cl-ok);border-color:var(--cl-ok);background:var(--cl-ok-wash);transform:none;box-shadow:none;opacity:1}
.c-detail{display:grid;gap:6px;padding-top:6px;margin-top:2px;border-top:1px dashed var(--cl-rule)}
.c-links{margin:0;padding:0;list-style:none;display:grid;gap:3px;font:var(--cl-text-small)}
.c-links li{display:flex;gap:6px;min-width:0;align-items:baseline}
.c-links li span:last-child{min-width:0;overflow-wrap:anywhere}
.c-banner{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:7px 12px;border-bottom:1px solid var(--cl-rule);background:var(--cl-warn-wash);color:var(--cl-ink-2);font:var(--cl-text-small)}
.clyde .cl-empty{border:0;border-radius:0;padding:24px 16px;gap:6px}
.c-desk>.cl-file{border:0;border-radius:0;background:transparent}
.c-desk>.cl-file pre{border:0;border-radius:0;background:var(--cl-paper-0);padding:10px 12px;max-height:360px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
.c-preview{margin-top:4px}
.c-preview .cl-file{border:1px solid var(--cl-rule);border-radius:var(--cl-radius-sm)}
.c-preview .cl-file pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;margin:0;padding:10px 12px}
.cl-file.is-compact .cl-file__head{border-bottom:0}
.cl-file__foot{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:6px 12px;border-top:1px solid var(--cl-rule);font:var(--cl-text-mono);font-size:11.5px;color:var(--cl-ink-3)}
.c-img{display:block;max-width:100%;max-height:420px;margin:0 auto;padding:8px 12px}
.cl-quest{display:block;border:0;border-radius:0;box-shadow:none;background:transparent;overflow:visible;min-width:0}
.cl-quest.is-done{background:transparent}
.cl-quest__main{display:grid;gap:6px;padding:10px 12px;min-width:0}
.cl-quest__main .c-say{padding:2px 0 0}
.cl-quest__head{display:flex;flex-wrap:wrap;align-items:center;gap:5px 8px;min-width:0}
.cl-quest__title{flex:1 1 180px;min-width:0;font:600 14px/19px var(--cl-font-sans);letter-spacing:-0.01em;margin:0;text-wrap:pretty;overflow-wrap:anywhere}
.cl-quest__brief{font:var(--cl-text-small);color:var(--cl-ink-2);margin:0;overflow-wrap:anywhere}
.cl-quest__done{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px;padding:4px 8px;border-radius:var(--cl-radius-sm);background:var(--cl-paper-2);font:var(--cl-text-small);color:var(--cl-ink);overflow-wrap:anywhere}
.cl-quest__for{font:var(--cl-text-mono);font-size:11px;line-height:16px;color:var(--cl-ink-3);overflow-wrap:anywhere}
.cl-quest__for b{color:var(--cl-ink-2);font-weight:600}
.c-qno{flex:none;font:600 11.5px/1 var(--cl-font-mono);color:var(--cl-ink-3);font-variant-numeric:tabular-nums}
.c-qact{display:inline-flex;align-items:center;gap:6px;margin-left:auto;flex:none;flex-wrap:wrap;max-width:100%}
.c-qstate{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:var(--cl-radius-xs);font:var(--cl-text-label);letter-spacing:0.06em;text-transform:uppercase;white-space:nowrap;background:var(--cl-paper-2);color:var(--cl-ink-2)}
.c-qstate--open{background:var(--cl-carbon-wash);color:var(--cl-carbon-ink)}
.c-qstate--claimed{background:var(--cl-warn-wash);color:var(--cl-warn)}
.c-qstate--done{background:var(--cl-ok-wash);color:var(--cl-ok)}
.c-qstate--abandoned{background:var(--cl-bad-wash);color:var(--cl-bad)}
.c-qstate.is-new{animation:cl-stamp var(--cl-dur-4) var(--cl-ease-stamp) both}
form.c-complete{display:grid;gap:var(--cl-space-2);padding-top:4px}
form.c-complete .cl-textarea{min-height:68px}
.c-agent-body{display:grid;gap:4px;padding:10px 12px;min-width:0}
.c-agent-desc{padding:0;color:var(--cl-ink-2)}
.c-err-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;min-width:0}
.c-err-row .c-text{flex:1 1 200px;min-width:0}
.c-skel{height:12px;border-radius:var(--cl-radius-sm);background:var(--cl-paper-2);margin:6px 12px}
@media (pointer:coarse){.c-toggle,.c-fold,.c-more,.c-art,.c-open,.c-ext,.c-claim,.c-complete-btn,.c-body-more,button.c-sum,button.c-qsum,.cl-btn{min-height:44px}}`;
