import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AutomationService, defaultAutomationConfig, parseAutomationConfig, broadcastRecipients } from './service.js';
import { MessagePipeline } from '../pipeline/pipeline.js';
import { MessageStore } from '../pipeline/messageStore.js';
import type { InboundMessage } from '../protocol/types.js';

function setup(t: any) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zapia-automation-'));
  let now=new Date(2026,10,2,10,0);
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'atendimento.json');
  const service=new AutomationService(file,()=>now);
  let count=0;
  const msg=(text: string): InboundMessage => ({chatId:'test@s.whatsapp.net',messageId:`m${++count}`,text,fromMe:false,timestamp:now.getTime()});
  const config=defaultAutomationConfig(); config.mode='menu';
  config.opcoes=[{id:'info',titulo:'Informações',resposta:'Texto programado',ativo:true,numero:1,cliques:0,subopcoes:[{id:'sub',titulo:'Escola',resposta:'Endereço',ativo:true,numero:1,cliques:0,subopcoes:[]}]}];
  service.save(config);
  return {service,file,config,msg,advance:(ms:number)=>{now=new Date(now.getTime()+ms);}};
}

test('imports both BotChat formats, validates before writing, and preserves a rejected file', t=>{
  const {service,file,config}=setup(t);
  const parsed=parseAutomationConfig({configuracoes:{avisoGlobal:'Aviso antigo'},opcoes:[{id:'a',titulo_menu:'Antigo',texto_resposta:'Resposta'}]});
  assert.equal(parsed.mode,'menu'); assert.equal(parsed.opcoes[0].resposta,'Resposta'); assert.equal(parsed.configuracoes.avisoGlobal.texto,'Aviso antigo');
  const before=fs.readFileSync(file,'utf8');
  assert.throws(()=>service.save({...config,configuracoes:{...config.configuracoes,expediente:{inicio:'99:00'}}}));
  assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.throws(()=>parseAutomationConfig({...config,opcoes:[config.opcoes[0],config.opcoes[0]]}));
});

test('greeting, active menus, submenu back and programmed answers use one conversation', t=>{
  const {service,msg}=setup(t);
  assert.match(service.reply(msg('Oi'),'Mateus')!,/Bom dia, Mateus/);
  assert.match(service.reply(msg('1'))!,/1. Escola\n2. Voltar/);
  assert.match(service.reply(msg('2'))!,/Escolha uma opção/);
  service.reply(msg('1'));
  assert.match(service.reply(msg('1'))!,/Endereço/);
  assert.equal(service.getConfig().opcoes[0].cliques,2);
  assert.equal(service.reply(msg('texto livre')),null);
});

test('hybrid falls back to AI only for free text; human handoff survives restart and config edits', t=>{
  const {service,msg,config,file}=setup(t); config.mode='hybrid';
  config.configuracoes.atendentes=[{id:'ana',nome:'Ana',ativo:true}]; service.save(config);
  service.reply(msg('oi'));
  assert.equal(service.reply(msg('Uma pergunta livre')),undefined);
  assert.match(service.reply(msg('2'))!,/Ana/);
  assert.match(service.reply(msg('1'))!,/Ana falará/);
  assert.equal(service.reply(msg('Outra pergunta')),null);
  const restarted=new AutomationService(file); restarted.save(config);
  assert.equal(restarted.reply(msg('oi')),null);
  restarted.manual({...msg('!encerrar'),fromMe:true});
  assert.match(restarted.reply(msg('oi'))!,/Escolha uma opção/);
});

test('manual pause applies to AI, extends on incoming interaction, and expires', t=>{
  const {service,msg,config,advance}=setup(t); config.mode='ai';service.save(config);
  assert.equal(service.reply(msg('oi')),undefined);
  service.manual({...msg('Vou responder pessoalmente'),fromMe:true});
  advance(29*60*1000); assert.equal(service.reply(msg('oi')),null);
  advance(29*60*1000); assert.equal(service.canReply(msg('').chatId),false);
  advance(2*60*1000); assert.equal(service.reply(msg('oi')),undefined);
});

test('office hours include overnight shifts and inactive greeting stays silent', t=>{
  const {service,msg,config}=setup(t);
  config.configuracoes.expediente={ativo:true,inicio:'22:00',fim:'11:00',dias:[0]};
  service.save(config); // Monday at 10 AM belongs to the Sunday overnight shift.
  assert.match(service.reply(msg('oi'))!,/Bom dia/);
  config.configuracoes.expediente.fim='06:00';service.save(config);
  assert.match(service.reply(msg('oi'))!,/fora do horário/);
  config.configuracoes.expediente.ativo=false;config.configuracoes.mensagemInicialAtiva=false;service.save(config);
  assert.equal(service.reply(msg('oi')),null);
});

test('broadcast validates all recipients before sending and normalizes/deduplicates numbers',()=>{
  assert.deepEqual(broadcastRecipients('(11) 99999-9999; +55 11 99999-9999'),['5511999999999@s.whatsapp.net']);
  assert.throws(()=>broadcastRecipients('11999999999;invalid'));
  assert.throws(()=>broadcastRecipients(Array(31).fill('11999999999').join(';')));
  assert.throws(()=>broadcastRecipients(''));
});

test('menu and AI share pipeline; manual takeover cancels pending AI and own echoes do not pause',async t=>{
  const {service,msg,config}=setup(t);
  const store=new MessageStore(':memory:');t.after(()=>store.close());
  const sent:string[]=[]; let generations=0;
  const pipeline=new MessagePipeline({store,engine:{id:'test',generate:async()=>{generations++;await sleep(25);return 'Resposta IA';}},
    routeReply:m=>service.reply(m,'Contato'),onManualMessage:m=>service.manual(m),
    sendText:async(chatId,text)=>{sent.push(text);pipeline.handleInbound({...msg(text),chatId,messageId:`out-${sent.length}`,fromMe:true});return {messageId:`out-${sent.length}`};},
    isSelected:()=>true,selectedCount:()=>1}, {enabled:true,debounceMs:0});
  pipeline.handleInbound(msg('oi'));await sleep(15);
  assert.equal(sent.length,1); assert.equal(generations,0); assert.equal(service.canReply(msg('').chatId),true);
  config.mode='hybrid';service.save(config);pipeline.handleInbound(msg('menu'));await sleep(15);
  pipeline.handleInbound(msg('Pergunta'));await sleep(5);
  pipeline.handleInbound({...msg('Resposta manual'),fromMe:true});await sleep(40);
  assert.equal(generations,1);assert.equal(sent.length,2);
  pipeline.handleInbound(msg('Outra pergunta'));await sleep(15);assert.equal(sent.length,2);
  pipeline.handleInbound({...msg('!encerrar'),fromMe:true});pipeline.handleInbound(msg('oi'));await sleep(15);assert.equal(sent.length,3);
});
