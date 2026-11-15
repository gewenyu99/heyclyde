// R67: the cards' own CSS, on top of the tokens. Chat width is 320 to 760 px, so everything is one column that wraps.
export const CARD_CSS = `
*{box-sizing:border-box}[hidden]{display:none!important}html,body{margin:0;padding:0;background:transparent}
body{color:var(--text);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
button,input,textarea{font:inherit;color:inherit}
.clyde{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;max-width:100%}
.bar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--bg);min-width:0}
.mark{flex:none;width:22px;height:22px;border-radius:6px;background:var(--brand);color:var(--on-brand);display:grid;place-items:center;
font-size:14px;font-weight:600;line-height:1;padding-bottom:2px}
.brand{font-weight:650;letter-spacing:-.2px}
.what{color:var(--muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.badge{flex:none;display:inline-flex;align-items:center;gap:6px;max-width:45%;padding:2px 9px 2px 7px;border:1px solid var(--border);
border-radius:999px;background:var(--surface);font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badge b{color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis}
.dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--muted)}.badge.on .dot{background:var(--ok);box-shadow:0 0 0 2px var(--ok-soft)}
.list{display:flex;flex-direction:column}
.item{padding:12px 14px;border-top:1px solid var(--border);min-width:0}.item:first-child{border-top:0}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;background:var(--bg-2);color:var(--text);
font-size:11.5px;font-weight:550;line-height:18px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.chip.fact{background:var(--ok-soft);color:var(--ok)}.chip.wen{background:var(--accent-soft);color:var(--accent)}
.chip.plan{background:var(--warn-soft);color:var(--warn)}.chip.warn{background:var(--warn-soft);color:var(--warn)}
.chip.bad{background:var(--bad-soft);color:var(--bad)}.chip.ok{background:var(--ok-soft);color:var(--ok)}
.chip.accent{background:var(--accent-soft);color:var(--accent)}
.conf{display:inline-flex;align-items:center;gap:5px;font-variant-numeric:tabular-nums}
.meter{width:42px;height:5px;border-radius:3px;background:var(--bg-2);overflow:hidden}.meter i{display:block;height:100%;background:var(--accent);border-radius:3px}
h3{margin:6px 0 2px;font-size:14.5px;line-height:1.35;font-weight:620;letter-spacing:-.1px;overflow-wrap:anywhere}
p{margin:4px 0 0;overflow-wrap:anywhere;white-space:pre-wrap}
.clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.muted{color:var(--muted)}.small{font-size:12px}.mono{font-family:var(--mono);font-size:12px}
blockquote{margin:8px 0 0;padding:6px 10px;border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:0 6px 6px 0;
font-size:13px;overflow-wrap:anywhere}
.prov{display:flex;align-items:center;gap:5px;margin-top:6px;font-size:12px;color:var(--muted);min-width:0}
.prov span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.art{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:4px 9px;border:1px solid var(--border);border-radius:var(--radius-sm);
background:var(--bg);font-size:12px;cursor:default}.art span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button.art{cursor:pointer}button.art:hover{border-color:var(--accent)}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px}.sp{flex:1}
.btn{appearance:none;display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border);background:var(--surface);color:var(--text);
font-size:12.5px;font-weight:550;padding:4px 10px;border-radius:var(--radius-sm);cursor:pointer;line-height:18px;white-space:nowrap}
.btn:hover{border-color:var(--muted)}.btn:disabled{opacity:.55;cursor:default}
.btn:focus-visible,.art:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn.used[aria-pressed=true]{background:var(--ok-soft);border-color:var(--ok);color:var(--ok)}
.btn.wrong[aria-pressed=true]{background:var(--bad-soft);border-color:var(--bad);color:var(--bad)}
.btn.ghost{border-color:transparent;background:transparent;color:var(--muted)}.btn.ghost:hover{color:var(--text)}
.i{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--border);background:var(--bg);font-size:12.5px}
.foot .muted{flex:1;min-width:140px}
.status{font-size:12.5px;margin-top:8px}.status.ok{color:var(--ok)}.status.bad{color:var(--bad)}
.detail{margin-top:10px;padding:10px 12px;border-radius:var(--radius-sm);background:var(--bg);border:1px solid var(--border)}
.detail h4{margin:8px 0 4px;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);font-weight:600}
.detail h4:first-child{margin-top:0}
.links{margin:0;padding:0;list-style:none;font-size:12.5px}.links li{display:flex;gap:6px;min-width:0;padding:2px 0}
.links li span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
pre{margin:0;padding:10px 12px;background:var(--code);border:1px solid var(--border);border-radius:var(--radius-sm);font:12px/1.5 var(--mono);
white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto}
.preview img{display:block;max-width:100%;max-height:420px;margin:0 auto;border-radius:var(--radius-sm);border:1px solid var(--border)}
.empty{padding:22px 14px;text-align:center;color:var(--muted)}
.hero{display:flex;align-items:center;gap:10px;padding:12px 14px}
.tick{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--ok-soft);color:var(--ok)}
.tick .i{width:16px;height:16px;stroke-width:2.2}
.hero.bad .tick{background:var(--bad-soft);color:var(--bad)}
.avatar{flex:none;width:44px;height:44px;border-radius:12px;display:grid;place-items:center;font-weight:650;font-size:17px;
background:var(--accent-soft);color:var(--accent);text-transform:uppercase}
.prio{display:inline-flex;align-items:center;gap:5px;font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.3px}
.prio::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--muted)}
.prio.high{color:var(--bad)}.prio.high::before{background:var(--bad)}.prio.normal::before{background:var(--accent)}
.done{margin-top:8px;padding:6px 10px;border-radius:var(--radius-sm);background:var(--bg);border:1px dashed var(--border);font-size:13px}
.done b{font-size:11.5px;text-transform:uppercase;letter-spacing:.3px;color:var(--muted);font-weight:600;margin-right:6px}
form.complete{display:flex;flex-direction:column;gap:6px;margin-top:10px}
form.complete label{font-size:12px;color:var(--muted)}
input,textarea{width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface)}
textarea{min-height:64px;resize:vertical}input:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
.skel{height:12px;border-radius:6px;background:linear-gradient(90deg,var(--bg-2),var(--bg),var(--bg-2));background-size:200% 100%;
animation:sh 1.2s infinite linear;margin:8px 0}@keyframes sh{to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.skel{animation:none}}
@media (max-width:420px){.badge{max-width:52%}.bar{padding:9px 12px}.item{padding:11px 12px}}
`;
