import fs from 'node:fs';
import path from 'node:path';
import type { InboundMessage } from '../protocol/types.js';

export type MenuOption = { id: string; titulo: string; resposta: string; ativo: boolean; numero: number; cliques: number; subopcoes: MenuOption[] };
export type Staff = { id: string; nome: string; ativo: boolean };
export type AutomationConfig = {
  mode: 'ai' | 'menu' | 'hybrid';
  configuracoes: {
    mensagemInicialAtiva: boolean; saudacao: string;
    avisoGlobal: { ativo: boolean; texto: string };
    expediente: { ativo: boolean; inicio: string; fim: string; dias: number[] };
    atendimentoHumano: { ativo: boolean }; atendentes: Staff[];
  };
  opcoes: MenuOption[];
};
export const defaultAutomationConfig = (): AutomationConfig => ({
  mode: 'ai', configuracoes: {
    mensagemInicialAtiva: true, saudacao: '{saudacao}, {nome}!',
    avisoGlobal: { ativo: false, texto: '' },
    expediente: { ativo: false, inicio: '08:00', fim: '17:00', dias: [1,2,3,4,5] },
    atendimentoHumano: { ativo: true }, atendentes: [],
  }, opcoes: [],
});

/** Accepts the desktop BotChat config.json and its earlier respostas.json format. */
export function parseAutomationConfig(value: unknown): AutomationConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Configuração inválida.');
  const raw = value as Record<string, any>;
  const defaults = defaultAutomationConfig();
  const c = raw.configuracoes ?? {};
  const bool = (v: unknown, fallback: boolean) => typeof v === 'boolean' ? v : fallback;
  const str = (v: unknown, fallback = '') => typeof v === 'string' ? v : fallback;
  if (raw.mode !== undefined && !['ai','menu','hybrid'].includes(raw.mode)) throw Error('Modo inválido.');
  const e = { ...defaults.configuracoes.expediente, ...c.expediente };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.inicio) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(e.fim)
      || !Array.isArray(e.dias) || e.dias.some((n: unknown) => !Number.isInteger(n) || Number(n)<0 || Number(n)>6)) throw Error('Expediente inválido.');
  function options(items: unknown, depth = 0): MenuOption[] {
    if (!Array.isArray(items) || items.length > 100 || (depth > 1 && items.length > 0)) throw Error('Lista de respostas inválida (máximo de um submenu).');
    const ids = new Set<string>();
    return items.map((o, i) => {
      if (!o || typeof o !== 'object') throw Error('Resposta inválida.');
      const titulo = str(o.titulo ?? o.titulo_menu).trim();
      const resposta = str(o.resposta ?? o.texto_resposta).trim();
      const id = str(o.id, `opcao-${i}`).trim();
      if (!titulo || !id || ids.has(id)) throw Error('Cada resposta precisa de título e identificador único.');
      ids.add(id);
      return { id, titulo, resposta, ativo: bool(o.ativo, true), numero: Number.isFinite(Number(o.numero)) ? Number(o.numero) : i+1,
        cliques: Math.max(0, Number(o.cliques)||0), subopcoes: options(o.subopcoes ?? [], depth+1) };
    });
  }
  const staff = c.atendentes ?? [];
  if (!Array.isArray(staff) || staff.length>100) throw Error('Atendentes inválidos.');
  const staffIDs = new Set<string>();
  return {
    mode: raw.mode ?? 'menu',
    configuracoes: {
      mensagemInicialAtiva: bool(c.mensagemInicialAtiva, true), saudacao: str(c.saudacao, defaults.configuracoes.saudacao),
      avisoGlobal: typeof c.avisoGlobal === 'string' ? { ativo: Boolean(c.avisoGlobal.trim()), texto: c.avisoGlobal } : {
        ativo: bool(c.avisoGlobal?.ativo, false), texto: str(c.avisoGlobal?.texto) },
      expediente: { ativo: bool(e.ativo, false), inicio: e.inicio, fim: e.fim, dias: e.dias },
      atendimentoHumano: { ativo: bool(c.atendimentoHumano?.ativo, true) },
      atendentes: staff.map((s, i) => {
        const id = str(s?.id, `atendente-${i}`), nome = str(s?.nome).trim();
        if (!nome || !id || staffIDs.has(id)) throw Error('Atendente inválido ou duplicado.');
        staffIDs.add(id); return { id, nome, ativo: bool(s.ativo, true) };
      }),
    }, opcoes: options(raw.opcoes ?? []),
  };
}

type Conversation = { started?: boolean; submenu?: string; human?: boolean; pauseUntil?: number };
/** Routing shared by menus and AI: a handoff suppresses both engines. */
export class AutomationService {
  private config: AutomationConfig;
  private conversations: Record<string, Conversation> = {};
  private stateFile: string;
  constructor(private file: string, private now = () => new Date()) {
    this.stateFile = path.join(path.dirname(file), 'atendimento-state.json');
    this.config = fs.existsSync(file) ? parseAutomationConfig(JSON.parse(fs.readFileSync(file, 'utf8'))) : defaultAutomationConfig();
    if (fs.existsSync(this.stateFile)) this.conversations = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
  }
  getConfig(): AutomationConfig { return structuredClone(this.config); }
  save(value: unknown): AutomationConfig {
    const next = parseAutomationConfig(value);
    this.write(this.file, next); this.config = next;
    // Config changes reset menus, but must never release an existing human handoff.
    for (const state of Object.values(this.conversations)) { delete state.submenu; delete state.started; }
    this.persistState(); return this.getConfig();
  }
  private write(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  private persistState(): void { this.write(this.stateFile, this.conversations); }
  canReply(chatId: string): boolean {
    const s = this.conversations[chatId];
    return !s?.human && !(s?.pauseUntil && s.pauseUntil > this.now().getTime());
  }
  manual(msg: InboundMessage): void {
    if (msg.text.trim().toLowerCase() === '!encerrar') {
      delete this.conversations[msg.chatId];
    } else {
      const s = this.conversations[msg.chatId] ??= {};
      s.pauseUntil = this.now().getTime() + 30*60*1000;
      delete s.submenu;
    }
    this.persistState();
  }
  pause(chatId: string): void {
    this.manual({ chatId, text: '', messageId: '', timestamp: this.now().getTime(), fromMe: true });
  }
  private activeOptions(): MenuOption[] { return this.config.opcoes.filter(o=>o.ativo).sort((a,b)=>a.numero-b.numero); }
  private menu(): string {
    const lines = this.activeOptions().map((o,i)=>`${i+1}. ${o.titulo}`);
    if (this.config.configuracoes.atendimentoHumano.ativo) lines.push(`${lines.length+1}. Falar com um atendente`);
    return lines.length ? `\n\n*Escolha uma opção:*\n${lines.join('\n')}` : '';
  }
  private submenu(items: { titulo?: string; nome?: string }[], title: string): string {
    return `\n\n*${title}*\n${items.map((o,i)=>`${i+1}. ${o.titulo ?? o.nome}`).join('\n')}\n${items.length+1}. Voltar`;
  }
  private inOffice(): boolean {
    const e = this.config.configuracoes.expediente;
    if (!e.ativo) return true;
    const date = this.now(), current = date.getHours()*60+date.getMinutes();
    const minutes = (s: string) => Number(s.slice(0,2))*60+Number(s.slice(3));
    const start = minutes(e.inicio), end = minutes(e.fim);
    if (start<=end) return e.dias.includes(date.getDay()) && current>=start && current<=end;
    return (current>=start && e.dias.includes(date.getDay())) || (current<=end && e.dias.includes((date.getDay()+6)%7));
  }
  /** undefined: use AI; null: stay silent; string: send programmed response. */
  reply(msg: InboundMessage, name = ''): string | null | undefined {
    const s = this.conversations[msg.chatId] ??= {};
    if (!this.canReply(msg.chatId)) {
      if (s.pauseUntil && s.pauseUntil>this.now().getTime()) { s.pauseUntil=this.now().getTime()+30*60*1000; this.persistState(); }
      return null;
    }
    if (this.config.mode === 'ai') return undefined;
    if (!this.inOffice()) return 'Nosso atendimento está fora do horário de expediente. Retornaremos assim que possível.';
    const text = msg.text.trim().toLowerCase();
    const cfg = this.config.configuracoes;
    if (text === 'voltar' || text === 'menu') { delete s.submenu; s.started=true; this.persistState(); return `Certo!${this.menu()}`; }
    const choice = /^\d+$/.test(text) ? Number(text) : NaN;
    if (s.submenu) {
      const human = s.submenu === '$staff';
      const parent = this.config.opcoes.find(o=>o.id===s.submenu);
      const items = human ? cfg.atendentes.filter(a=>a.ativo) : (parent?.subopcoes ?? []).filter(o=>o.ativo);
      const title = human ? 'Escolha o atendente' : parent?.titulo ?? 'Opções';
      if (choice === items.length+1) { delete s.submenu; this.persistState(); return `Certo!${this.menu()}`; }
      if (!Number.isInteger(choice) || choice<1 || choice>items.length) return `Opção inválida.${this.submenu(items,title)}`;
      const item = items[choice-1]; delete s.submenu;
      if (human) s.human=true;
      this.persistState();
      return human ? `Aguarde um momento, ${(item as Staff).nome} falará com você em breve.` : `${(item as MenuOption).resposta}\n\nDigite *voltar* para ver todas as opções novamente.`;
    }
    if (!s.started) {
      if (!cfg.mensagemInicialAtiva) return this.config.mode==='hybrid' ? undefined : null;
      const h = this.now().getHours(), greeting = h<12 ? 'Bom dia' : h<18 ? 'Boa tarde' : 'Boa noite';
      let hello = cfg.saudacao.replaceAll('{saudacao}', greeting);
      hello = name ? hello.replaceAll('{nome}', name) : hello.replace(/[\s,–—-]*\{nome\}/g,'').trim();
      s.started=true; this.persistState();
      return `${hello}${cfg.avisoGlobal.ativo && cfg.avisoGlobal.texto.trim() ? `\n\n📢 *Aviso:* ${cfg.avisoGlobal.texto.trim()}` : ''}${this.menu()}`;
    }
    if (!Number.isInteger(choice)) return this.config.mode==='hybrid' ? undefined : null;
    const options=this.activeOptions();
    if (cfg.atendimentoHumano.ativo && choice===options.length+1) {
      const staff=cfg.atendentes.filter(a=>a.ativo);
      if (!staff.length) { s.human=true; this.persistState(); return 'Aguarde um momento, um de nossos atendentes falará com você em breve.'; }
      s.submenu='$staff'; this.persistState(); return this.submenu(staff,'Escolha o atendente');
    }
    const option=options[choice-1];
    if (!option) return `Opção inválida.${this.menu()}`;
    option.cliques++; this.write(this.file,this.config);
    const subs=option.subopcoes.filter(o=>o.ativo);
    if (subs.length) { s.submenu=option.id; this.persistState(); return `${option.resposta}${this.submenu(subs,option.titulo)}`; }
    return `${option.resposta}\n\nDigite *voltar* para ver todas as opções novamente.`;
  }
}

export function broadcastRecipients(value: string): string[] {
  const values=value.split(/[\n,;]+/).map(v=>v.trim()).filter(Boolean);
  if (!values.length || values.length>30) throw Error('Informe de 1 a 30 contatos.');
  return [...new Set(values.map(v=>{
    if (!/^[+\d\s().-]+$/.test(v)) throw Error(`Número inválido: ${v}`);
    let n=v.replace(/\D/g,''); if (n.length===10 || n.length===11) n=`55${n}`;
    if (n.length<10 || n.length>15) throw Error(`Número inválido: ${v}`);
    return `${n}@s.whatsapp.net`;
  }))];
}
