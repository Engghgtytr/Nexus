/* ===========================================================
   Nexus — front-end (app.js)
   Conecta ao servidor por WebSocket (Socket.IO) e faz a
   navegação entre servidores, canais e mensagens em tempo real.
   =========================================================== */

const app = document.getElementById("app");
const EU = { id: parseInt(app.dataset.uid), nome: app.dataset.unome };

let socket = null;
let servidorAtual = null;
let canalAtual = null;
let ultimoAutor = null;
let timerDigitando = null;
let respondendoA = null;   // {id, autor, conteudo} quando respondendo
const EMOJIS_RAPIDOS = ["👍", "❤️", "😂", "🔥", "🎉", "😮"];

/* ---------------- utilidades ---------------- */
function corDe(str) {
  // cor derivada do nome (estável) para avatares
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  const paleta = ["#a855f7", "#f0663f", "#5b8def", "#c084fc", "#f4b740", "#4ade80", "#fb7185"];
  return paleta[Math.abs(h) % paleta.length];
}
function iniciais(nome) { return (nome || "?").trim()[0].toUpperCase(); }
function horaBonita(iso) {
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d)) return "";
  const hoje = new Date();
  const mesmaData = d.toDateString() === hoje.toDateString();
  const hm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return mesmaData ? `hoje às ${hm}` : d.toLocaleDateString("pt-BR") + " " + hm;
}
function escapar(t) {
  const d = document.createElement("div");
  d.textContent = t;
  return d.innerHTML;
}
async function jget(url) { const r = await fetch(url); return r.json(); }
async function jpost(url, corpo) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo || {}) });
  return { ok: r.ok, dados: await r.json() };
}

/* ---------------- alternar tela inicial (amigos) x chat ---------------- */
let dmAtual = null; // conversa_id de DM aberta (null quando é canal de servidor)
let amigoDaConversaAtual = null; // {id, nome, cor} do amigo da DM aberta, para o botão de ligar

function mostrarTelaAmigos() {
  document.getElementById("telaAmigos").hidden = false;
  document.getElementById("chatCabecalho").hidden = true;
  document.getElementById("mensagens").hidden = true;
  document.getElementById("formEnvio").hidden = true;
  document.getElementById("colMembros").hidden = true;
  document.getElementById("servidorNome").textContent = "Mensagens diretas";
  document.getElementById("btnConvite").hidden = true;
  document.querySelectorAll(".srv-btn").forEach((x) => x.classList.remove("ativo"));
  document.querySelector('.srv-btn.inicio').classList.add("ativo");
  sairDoCanalOuDMAtual();
  carregarListaDMs();
  renderizarAbaAmigos();
}
function mostrarChat() {
  document.getElementById("telaAmigos").hidden = true;
  document.getElementById("chatCabecalho").hidden = false;
  document.getElementById("mensagens").hidden = false;
  document.getElementById("formEnvio").hidden = false;
}
function sairDoCanalOuDMAtual() {
  if (canalAtual && socket) { socket.emit("sair_canal", { canal_id: canalAtual }); canalAtual = null; }
  if (dmAtual && socket) { socket.emit("sair_dm", { conversa_id: dmAtual }); dmAtual = null; }
}

/* ---------------- lista de conversas de DM (coluna 2, na tela Início) ---------------- */
async function carregarListaDMs() {
  const cont = document.getElementById("canaisLista");
  const convs = await jget("/api/dm/conversas");
  cont.innerHTML = "";
  const titulo = document.createElement("div");
  titulo.className = "categoria-titulo";
  titulo.innerHTML = "<span>Conversas</span>";
  cont.appendChild(titulo);
  if (!convs.length) {
    const vazio = document.createElement("div");
    vazio.className = "vazio-canais";
    vazio.textContent = "Nenhuma conversa ainda. Adicione amigos para começar.";
    cont.appendChild(vazio);
    return;
  }
  convs.forEach((c) => cont.appendChild(itemConversaDM(c)));
}
function itemConversaDM(c) {
  const el = document.createElement("div");
  el.className = "canal-item item-dm";
  el.dataset.conversa = c.conversa_id;
  const cor = c.cor && c.cor !== "#a855f7" ? c.cor : corDe(c.nome);
  el.innerHTML = `
    <span class="dm-avatar-mini" style="background:${cor}">${iniciais(c.nome)}${c.online ? '<span class="ponto-online"></span>' : ""}</span>
    <span class="dm-info-mini">
      <span class="dm-nome-mini">${escapar(c.nome)}</span>
      <span class="dm-preview-mini">${c.ultima ? escapar(c.ultima).slice(0, 30) : "Sem mensagens ainda"}</span>
    </span>
    ${c.nao_lidas ? `<span class="dm-badge">${c.nao_lidas}</span>` : ""}`;
  el.addEventListener("click", () => abrirDM(c.id, c.nome, cor, el));
  return el;
}

async function abrirDM(amigoId, nome, cor, el) {
  const r = await jpost(`/api/dm/abrir/${amigoId}`);
  if (!r.ok) { alert(r.dados.erro || "Não foi possível abrir a conversa."); return; }
  const cid = r.dados.conversa_id;

  if (canalAtual && socket) { socket.emit("sair_canal", { canal_id: canalAtual }); canalAtual = null; }
  if (dmAtual && socket) socket.emit("sair_dm", { conversa_id: dmAtual });
  dmAtual = cid;
  amigoDaConversaAtual = { id: parseInt(amigoId), nome, cor };
  ultimoAutor = null;

  document.querySelectorAll(".canal-item").forEach((x) => x.classList.remove("ativo"));
  if (el) el.classList.add("ativo");

  document.getElementById("canalNome").textContent = nome;
  document.getElementById("canalDescricao").textContent = "";
  document.querySelector(".canal-hash").textContent = "@";
  document.getElementById("formEnvio").hidden = false;
  document.getElementById("botoesLigar").hidden = false;
  mostrarChat();

  socket.emit("entrar_dm", { conversa_id: cid });

  const msgs = await jget(`/api/dm/${cid}/mensagens`);
  const cont = document.getElementById("mensagens");
  cont.innerHTML = "";
  if (!msgs.length) {
    cont.innerHTML = `<div class="boas-vindas"><div class="bv-icone"><img class="av-logo" src="/static/img/logo.png" alt=""></div>
      <h2>${escapar(nome)}</h2><p>Essa é a sua conversa com ${escapar(nome)}. Mande a primeira mensagem.</p></div>`;
  } else {
    msgs.forEach((m) => adicionarMensagem(m, true));
  }
  document.getElementById("entradaMsg").focus();
  carregarListaDMs(); // atualiza contagem de não lidas
}

/* ---------------- aba Amigos: renderização ---------------- */
let abaAmigosAtiva = "todos";
document.getElementById("amigosAbas").addEventListener("click", (e) => {
  const b = e.target.closest("[data-aba]");
  if (!b) return;
  abaAmigosAtiva = b.dataset.aba;
  document.querySelectorAll("#amigosAbas .aba").forEach((x) => x.classList.remove("ativa"));
  b.classList.add("ativa");
  renderizarAbaAmigos();
});

async function renderizarAbaAmigos() {
  const cont = document.getElementById("amigosCorpo");
  const dados = await jget("/api/amigos");

  if (abaAmigosAtiva === "adicionar") {
    cont.innerHTML = `
      <div class="add-amigo-caixa">
        <h2>Adicionar amigo</h2>
        <p class="m-sub">Você pode adicionar amigos pelo nome de usuário do Nexus (com ou sem @).</p>
        <form id="formAddAmigo" class="add-amigo-form">
          <input type="text" id="inputAddAmigo" placeholder="Digite um nome de usuário" maxlength="24">
          <button type="submit" class="btn-pri">Enviar pedido</button>
        </form>
        <p class="add-amigo-msg" id="addAmigoMsg"></p>
      </div>`;
    document.getElementById("formAddAmigo").addEventListener("submit", async (e) => {
      e.preventDefault();
      const inp = document.getElementById("inputAddAmigo");
      const msg = document.getElementById("addAmigoMsg");
      const nome = inp.value.trim();
      if (!nome) return;
      const { ok, dados: d } = await jpost("/api/amigos/solicitar", { usuario: nome });
      if (ok) {
        msg.className = "add-amigo-msg sucesso";
        msg.textContent = d.status === "aceita" ? `Vocês agora são amigos!` : `Pedido enviado para ${nome}.`;
        inp.value = "";
        renderizarAbaAmigos.ultimaAtualizacao = Date.now();
      } else {
        msg.className = "add-amigo-msg erro";
        msg.textContent = d.erro || "Não foi possível enviar o pedido.";
      }
    });
    return;
  }

  if (abaAmigosAtiva === "pendentes") {
    const total = dados.recebidos.length + dados.enviados.length;
    if (!total) {
      cont.innerHTML = vazioAmigos("Nenhum pedido pendente", "Pedidos de amizade que você enviar ou receber aparecem aqui.");
      return;
    }
    let html = "";
    if (dados.recebidos.length) {
      html += `<div class="amigos-secao"><h3>Pedidos recebidos — ${dados.recebidos.length}</h3><div class="lista-amigos">`;
      dados.recebidos.forEach((p) => {
        const cor = corDe(p.nome);
        html += `<div class="amigo-card">
          <span class="amigo-avatar" style="background:${cor}">${iniciais(p.nome)}</span>
          <div class="amigo-info"><span class="amigo-nome">${escapar(p.nome)}</span><span class="amigo-tag">@${escapar(p.usuario)}</span></div>
          <div class="amigo-acoes">
            <button class="btn-pri btn-pequeno" data-aceitar="${p.pedido_id}">Aceitar</button>
            <button class="btn-sec btn-pequeno" data-recusar="${p.pedido_id}">Recusar</button>
          </div></div>`;
      });
      html += `</div></div>`;
    }
    if (dados.enviados.length) {
      html += `<div class="amigos-secao"><h3>Pedidos enviados — ${dados.enviados.length}</h3><div class="lista-amigos">`;
      dados.enviados.forEach((p) => {
        const cor = corDe(p.nome);
        html += `<div class="amigo-card">
          <span class="amigo-avatar" style="background:${cor}">${iniciais(p.nome)}</span>
          <div class="amigo-info"><span class="amigo-nome">${escapar(p.nome)}</span><span class="amigo-tag">Pendente</span></div>
        </div>`;
      });
      html += `</div></div>`;
    }
    cont.innerHTML = html;
    cont.querySelectorAll("[data-aceitar]").forEach((b) => b.onclick = async () => {
      await jpost(`/api/amigos/${b.dataset.aceitar}/responder`, { aceitar: true });
      renderizarAbaAmigos();
    });
    cont.querySelectorAll("[data-recusar]").forEach((b) => b.onclick = async () => {
      await jpost(`/api/amigos/${b.dataset.recusar}/responder`, { aceitar: false });
      renderizarAbaAmigos();
    });
    return;
  }

  if (abaAmigosAtiva === "bloqueados") {
    if (!dados.bloqueados.length) {
      cont.innerHTML = vazioAmigos("Ninguém bloqueado", "Usuários bloqueados não podem te chamar nem te adicionar.");
      return;
    }
    let html = `<div class="amigos-secao"><div class="lista-amigos">`;
    dados.bloqueados.forEach((b) => {
      const cor = corDe(b.nome);
      html += `<div class="amigo-card">
        <span class="amigo-avatar" style="background:${cor}">${iniciais(b.nome)}</span>
        <div class="amigo-info"><span class="amigo-nome">${escapar(b.nome)}</span><span class="amigo-tag">@${escapar(b.usuario)}</span></div>
        <div class="amigo-acoes"><button class="btn-sec btn-pequeno" data-desbloq="${b.id}">Desbloquear</button></div>
      </div>`;
    });
    html += `</div></div>`;
    cont.innerHTML = html;
    cont.querySelectorAll("[data-desbloq]").forEach((b) => b.onclick = async () => {
      await jpost(`/api/amigos/${b.dataset.desbloq}/desbloquear`);
      renderizarAbaAmigos();
    });
    return;
  }

  // aba "todos"
  if (!dados.amigos.length) {
    cont.innerHTML = vazioAmigos("Ainda sem amigos por aqui", "Adicione alguém pelo nome de usuário na aba \"Adicionar amigo\" para começar a conversar.");
    return;
  }
  let html = `<div class="amigos-secao"><h3>Todos os amigos — ${dados.amigos.length}</h3><div class="lista-amigos">`;
  dados.amigos.forEach((a) => {
    const cor = a.cor && a.cor !== "#a855f7" ? a.cor : corDe(a.nome);
    html += `<div class="amigo-card">
      <span class="amigo-avatar" style="background:${cor}">${iniciais(a.nome)}${a.online ? '<span class="ponto-online"></span>' : ""}</span>
      <div class="amigo-info"><span class="amigo-nome">${escapar(a.nome)}</span><span class="amigo-tag">${a.online ? "Online" : "Offline"}</span></div>
      <div class="amigo-acoes">
        <button class="btn-pri btn-pequeno" data-msg="${a.id}" data-nome="${escapar(a.nome)}" data-cor="${cor}">Mensagem</button>
        <button class="acao-msg" data-remover="${a.id}" title="Remover">✕</button>
        <button class="acao-msg" data-bloquear="${a.id}" title="Bloquear">⛔</button>
      </div></div>`;
  });
  html += `</div></div>`;
  cont.innerHTML = html;
  cont.querySelectorAll("[data-msg]").forEach((b) => b.onclick = () => abrirDM(b.dataset.msg, b.dataset.nome, b.dataset.cor));
  cont.querySelectorAll("[data-remover]").forEach((b) => b.onclick = async () => {
    if (confirm("Remover esta amizade?")) { await jpost(`/api/amigos/${b.dataset.remover}/remover`); renderizarAbaAmigos(); }
  });
  cont.querySelectorAll("[data-bloquear]").forEach((b) => b.onclick = async () => {
    if (confirm("Bloquear este usuário?")) { await jpost(`/api/amigos/${b.dataset.bloquear}/bloquear`); renderizarAbaAmigos(); }
  });
}
function vazioAmigos(titulo, texto) {
  return `<div class="amigos-vazio">
    <div class="av-ilustra" aria-hidden="true"><img class="av-logo" src="/static/img/logo.png" alt=""></div>
    <h2>${titulo}</h2><p>${texto}</p>
  </div>`;
}

/* ---------------- WebSocket ---------------- */
function conectarSocket() {
  socket = io();
  socket.on("nova_mensagem", (m) => {
    if (m.canal_id === canalAtual) adicionarMensagem(m);
    // toca som só quando é de outra pessoa (não nas suas próprias)
    if (m.autor_id !== EU.id) tocarNotificacao();
  });
  socket.on("mensagem_editada", (d) => {
    if (d.canal_id !== canalAtual) return;
    const el = document.querySelector(`.msg[data-id="${d.id}"] .msg-texto`);
    if (el) { el.innerHTML = escapar(d.conteudo) + ' <span class="editada">(editada)</span>'; }
  });
  socket.on("mensagem_apagada", (d) => {
    if (d.canal_id !== canalAtual) return;
    const el = document.querySelector(`.msg[data-id="${d.id}"]`);
    if (el) el.remove();
  });
  socket.on("reacao_atualizada", (d) => {
    if (d.canal_id !== canalAtual) return;
    atualizarReacaoUI(d);
  });
  socket.on("usuario_digitando", (d) => {
    if (d.canal_id !== canalAtual) return;
    const aviso = document.getElementById("digitandoAviso");
    aviso.textContent = `${d.nome} está digitando...`;
    clearTimeout(timerDigitando);
    timerDigitando = setTimeout(() => (aviso.textContent = ""), 2500);
  });

  /* ---- eventos de DM ---- */
  socket.on("nova_dm", (m) => {
    if (m.conversa_id === dmAtual) adicionarMensagem(m, true);
    if (m.autor_id !== EU.id) tocarNotificacao();
  });
  socket.on("dm_editada", (d) => {
    if (d.conversa_id !== dmAtual) return;
    const el = document.querySelector(`.msg[data-id="${d.id}"] .msg-texto`);
    if (el) el.innerHTML = escapar(d.conteudo) + ' <span class="editada">(editada)</span>';
  });
  socket.on("dm_apagada", (d) => {
    if (d.conversa_id !== dmAtual) return;
    const el = document.querySelector(`.msg[data-id="${d.id}"]`);
    if (el) el.remove();
  });
  socket.on("dm_recebida_resumo", () => {
    // atualiza a lista de conversas (não lidas, prévia) mesmo sem o chat aberto
    if (!document.getElementById("telaAmigos").hidden) carregarListaDMs();
  });

  /* ---- eventos de amizade / presença ---- */
  socket.on("novo_pedido_amizade", () => {
    tocarNotificacao();
    if (!document.getElementById("telaAmigos").hidden) renderizarAbaAmigos();
  });
  socket.on("pedido_aceito", () => {
    if (!document.getElementById("telaAmigos").hidden) { renderizarAbaAmigos(); carregarListaDMs(); }
  });
  socket.on("pedido_recusado", () => {
    if (!document.getElementById("telaAmigos").hidden) renderizarAbaAmigos();
  });
  socket.on("amigo_removido", () => {
    if (!document.getElementById("telaAmigos").hidden) { renderizarAbaAmigos(); carregarListaDMs(); }
  });
  socket.on("amigo_status", () => {
    if (!document.getElementById("telaAmigos").hidden) { renderizarAbaAmigos(); carregarListaDMs(); }
  });
}

/* ---------------- servidores ---------------- */
async function carregarServidores() {
  const servidores = await jget("/api/servidores");
  const lista = document.getElementById("srvLista");
  lista.innerHTML = "";
  servidores.forEach((s) => {
    const b = document.createElement("button");
    b.className = "srv-btn";
    b.dataset.servidor = s.id;
    b.title = s.nome;
    b.innerHTML = `<span class="srv-icone-letra">${iniciais(s.nome)}</span>`;
    b.style.setProperty("--cor", corDe(s.nome));
    b.addEventListener("click", () => abrirServidor(s.id, b));
    lista.appendChild(b);
  });
}

async function abrirServidor(sid, botao) {
  document.querySelectorAll(".srv-btn").forEach((x) => x.classList.remove("ativo"));
  if (botao) botao.classList.add("ativo");

  const s = await jget(`/api/servidores/${sid}`);
  if (s.erro) { alert(s.erro); return; }
  servidorAtual = s;
  const minhasPerms = new Set(s.minhas_permissoes || []);
  const podeGerenciarCanais = s.sou_dono || minhasPerms.has("gerenciar_canais");
  const podeGerenciarCargos = s.sou_dono || minhasPerms.has("gerenciar_cargos");
  const podeExpulsar = s.sou_dono || minhasPerms.has("expulsar_membros");
  const podeBanir = s.sou_dono || minhasPerms.has("banir_membros");

  document.getElementById("servidorNome").textContent = s.nome;
  const btnConvite = document.getElementById("btnConvite");
  btnConvite.hidden = false;
  btnConvite.onclick = () => mostrarConvite(s.convite);

  const btnCargos = document.getElementById("btnCargos");
  btnCargos.hidden = !podeGerenciarCargos;
  btnCargos.onclick = () => abrirModalCargos(sid);

  // monta canais por categoria
  const cont = document.getElementById("canaisLista");
  cont.innerHTML = "";
  s.categorias.forEach((cat) => {
    const tit = document.createElement("div");
    tit.className = "categoria-titulo";
    tit.innerHTML = `<span>${escapar(cat.nome)}</span>` +
      (podeGerenciarCanais ? `<button class="categoria-add" title="Novo canal">+</button>` : "");
    if (podeGerenciarCanais) tit.querySelector(".categoria-add").onclick = () => criarCanal(sid, cat.id);
    cont.appendChild(tit);
    cat.canais.forEach((c) => cont.appendChild(itemCanal(c, sid, podeGerenciarCanais, s.cargos)));
  });
  s.sem_categoria.forEach((c) => cont.appendChild(itemCanal(c, sid, podeGerenciarCanais, s.cargos)));
  if (podeGerenciarCanais) {
    const addCat = document.createElement("button");
    addCat.className = "btn-sec btn-nova-categoria";
    addCat.textContent = "+ Nova categoria";
    addCat.onclick = () => criarCategoria(sid);
    cont.appendChild(addCat);
  }

  // membros
  const colM = document.getElementById("colMembros");
  colM.hidden = false;
  const ml = document.getElementById("membrosLista");
  ml.innerHTML = "";
  s.membros.forEach((m) => {
    const el = document.createElement("div");
    el.className = "membro-item";
    const cor = m.cor && m.cor !== "#a855f7" ? m.cor : corDe(m.nome);
    const papel = m.papel === "dono" ? '<span class="membro-papel papel-dono">dono</span>' : "";
    const badgesCargo = (m.cargos || []).map((c) =>
      `<span class="badge-cargo" style="color:${c.cor};border-color:${c.cor}55;background:${c.cor}18">${escapar(c.nome)}</span>`
    ).join("");
    const podeAgir = (podeGerenciarCargos || podeExpulsar || podeBanir) && m.papel !== "dono" && m.id !== EU.id;
    el.innerHTML = `
      <span class="membro-avatar" style="background:${cor}">${iniciais(m.nome)}</span>
      <span class="membro-nome-wrap">
        <span class="membro-nome">${escapar(m.nome)}</span>
        <span class="membro-badges">${badgesCargo}</span>
      </span>${papel}
      ${podeAgir ? '<button class="acao-msg btn-membro-menu" title="Gerenciar">⋮</button>' : ""}`;
    if (podeAgir) {
      el.querySelector(".btn-membro-menu").onclick = (e) =>
        abrirMenuMembro(e, sid, m, s.cargos, { podeGerenciarCargos, podeExpulsar, podeBanir });
    }
    ml.appendChild(el);
  });

  // abre o primeiro canal automaticamente
  const primeiro = cont.querySelector(".canal-item");
  if (primeiro) primeiro.click();
}

function itemCanal(c, sid, podeGerenciar, cargosDoServidor) {
  const el = document.createElement("div");
  el.className = "canal-item";
  el.dataset.canal = c.id;
  const restrito = c.cargos_permitidos && c.cargos_permitidos.length > 0;
  el.innerHTML = `<span class="hash">${restrito ? "🔒" : "#"}</span> <span class="canal-nome-texto">${escapar(c.nome)}</span>` +
    (podeGerenciar ? `<button class="canal-editar" title="Editar canal">⚙</button>` : "");
  el.querySelector(".canal-nome-texto").parentNode.addEventListener("click", (e) => {
    if (e.target.closest(".canal-editar")) return;
    abrirCanal(c, el);
  });
  if (podeGerenciar) {
    el.querySelector(".canal-editar").addEventListener("click", (e) => {
      e.stopPropagation();
      abrirModalEditarCanal(sid, c, cargosDoServidor);
    });
  }
  return el;
}

async function criarCategoria(sid) {
  const nome = prompt("Nome da nova categoria:");
  if (!nome || !nome.trim()) return;
  const { ok, dados } = await jpost(`/api/servidores/${sid}/categorias`, { nome: nome.trim() });
  if (ok) abrirServidor(sid, document.querySelector(`.srv-btn[data-servidor="${sid}"]`));
  else alert(dados.erro || "Erro ao criar categoria.");
}

function abrirModalEditarCanal(sid, canal, cargos) {
  modalFundo.hidden = false;
  const checks = (cargos || []).map((c) => `
    <label class="check-cargo">
      <input type="checkbox" value="${c.id}" ${canal.cargos_permitidos.includes(c.id) ? "checked" : ""}>
      <span style="color:${c.cor}">${escapar(c.nome)}</span>
    </label>`).join("") || '<p class="m-sub">Nenhum cargo criado ainda. Sem cargos marcados, o canal fica visível a todos.</p>';
  modal.innerHTML = `
    <div class="modal-topo">
      <h2>Editar #${escapar(canal.nome)}</h2>
      <button class="modal-fechar" id="mFechar">&times;</button>
    </div>
    <label>Nome do canal<input id="editCanalNome" value="${escapar(canal.nome)}"></label>
    <label>Descrição<input id="editCanalDesc" value="${escapar(canal.descricao || "")}" placeholder="Opcional"></label>
    <p class="m-sub" style="margin-top:14px">Restringir a cargos específicos (vazio = todos veem):</p>
    <div class="lista-checks-cargo">${checks}</div>
    <div class="modal-acoes">
      <button class="btn-sec" id="mExcluirCanal" style="margin-right:auto;color:var(--coral)">Excluir canal</button>
      <button class="btn-sec" id="mFechar2">Cancelar</button>
      <button class="btn-pri" id="mSalvarCanal">Salvar</button>
    </div>`;
  document.getElementById("mFechar").onclick = fecharModal;
  document.getElementById("mFechar2").onclick = fecharModal;
  document.getElementById("mSalvarCanal").onclick = async () => {
    const nome = document.getElementById("editCanalNome").value.trim();
    const descricao = document.getElementById("editCanalDesc").value.trim();
    const marcados = [...modal.querySelectorAll(".check-cargo input:checked")].map((i) => parseInt(i.value));
    const { ok, dados } = await A_jputCanal(canal.id, { nome, descricao, cargos_permitidos: marcados });
    if (ok) { fecharModal(); abrirServidor(sid, document.querySelector(`.srv-btn[data-servidor="${sid}"]`)); }
    else alert(dados.erro || "Erro ao salvar.");
  };
  document.getElementById("mExcluirCanal").onclick = async () => {
    if (!confirm(`Excluir o canal #${canal.nome}? Isso apaga todas as mensagens dele.`)) return;
    const r = await fetch(`/api/canais/${canal.id}`, { method: "DELETE" });
    if (r.ok) { fecharModal(); abrirServidor(sid, document.querySelector(`.srv-btn[data-servidor="${sid}"]`)); }
    else alert("Erro ao excluir canal.");
  };
}
async function A_jputCanal(cid, corpo) {
  const r = await fetch(`/api/canais/${cid}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
  return { ok: r.ok, dados: await r.json() };
}

/* ---------------- canais e mensagens ---------------- */
async function abrirCanal(canal, el) {
  // sai do canal anterior (socket) e de qualquer DM aberta
  if (canalAtual && socket) socket.emit("sair_canal", { canal_id: canalAtual });
  if (dmAtual && socket) { socket.emit("sair_dm", { conversa_id: dmAtual }); dmAtual = null; }

  document.querySelectorAll(".canal-item").forEach((x) => x.classList.remove("ativo"));
  if (el) el.classList.add("ativo");
  canalAtual = canal.id;
  ultimoAutor = null;
  amigoDaConversaAtual = null;
  document.querySelector(".canal-hash").textContent = "#";
  document.getElementById("botoesLigar").hidden = true;
  mostrarChat();

  document.getElementById("canalNome").textContent = canal.nome;
  document.getElementById("canalDescricao").textContent = canal.descricao || "";
  document.getElementById("formEnvio").hidden = false;

  socket.emit("entrar_canal", { canal_id: canal.id });

  const msgs = await jget(`/api/canais/${canal.id}/mensagens`);
  const cont = document.getElementById("mensagens");
  cont.innerHTML = "";
  if (!msgs.length) {
    cont.innerHTML = `<div class="boas-vindas"><div class="bv-icone"><img class="av-logo" src="/static/img/logo.png" alt=""></div>
      <h2>#${escapar(canal.nome)}</h2><p>Este é o começo do canal. Mande a primeira mensagem.</p></div>`;
  } else {
    msgs.forEach((m) => adicionarMensagem(m));
  }
  document.getElementById("entradaMsg").focus();
}

function adicionarMensagem(m, isDM) {
  const cont = document.getElementById("mensagens");
  const bv = cont.querySelector(".boas-vindas");
  if (bv) bv.remove();

  const agrupada = (ultimoAutor === m.autor_id) && !m.responde_a;
  const cor = m.cor && m.cor !== "#a855f7" ? m.cor : corDe(m.autor);
  const souAutor = (m.autor_id === EU.id);
  const el = document.createElement("div");
  el.className = "msg" + (agrupada ? " agrupada" : "");
  el.dataset.id = m.id;
  el.dataset.autorId = m.autor_id;

  const citacao = m.resposta ? `
    <div class="msg-citacao">
      <span class="cit-autor">${escapar(m.resposta.autor)}</span>
      <span class="cit-texto">${escapar(m.resposta.conteudo).slice(0, 120)}</span>
    </div>` : "";

  const marcaEditada = m.editada ? ' <span class="editada">(editada)</span>' : "";

  el.innerHTML = `
    <div class="msg-avatar" style="background:${cor}">${iniciais(m.autor)}</div>
    <div class="msg-corpo">
      ${citacao}
      <div class="msg-cabecalho">
        <span class="msg-autor" style="color:${cor}">${escapar(m.autor)}</span>
        <span class="msg-hora">${horaBonita(m.criado_em)}</span>
      </div>
      <div class="msg-texto">${escapar(m.conteudo)}${marcaEditada}</div>
      <div class="msg-reacoes"></div>
    </div>
    <div class="msg-acoes">
      ${isDM ? "" : '<button class="acao-msg" data-a="reagir" title="Reagir">☺</button>'}
      <button class="acao-msg" data-a="responder" title="Responder">↰</button>
      ${souAutor ? '<button class="acao-msg" data-a="editar" title="Editar">✎</button>' : ""}
      ${souAutor ? '<button class="acao-msg" data-a="apagar" title="Apagar">🗑</button>' : ""}
    </div>`;

  // ações
  if (!isDM) el.querySelector('[data-a="reagir"]').onclick = (e) => abrirSeletorEmoji(e, m.id);
  el.querySelector('[data-a="responder"]').onclick = () => iniciarResposta(m);
  if (souAutor) {
    el.querySelector('[data-a="editar"]').onclick = () => iniciarEdicao(el, m, isDM);
    el.querySelector('[data-a="apagar"]').onclick = () => {
      if (confirm("Apagar esta mensagem?")) socket.emit(isDM ? "apagar_dm" : "apagar_mensagem", { id: m.id });
    };
  }

  cont.appendChild(el);
  // renderiza reações existentes (não se aplica a DM)
  if (!isDM) (m.reacoes || []).forEach((r) => desenharReacao(m.id, r.emoji, r.total, r.eu));
  cont.scrollTop = cont.scrollHeight;
  ultimoAutor = m.responde_a ? null : m.autor_id;
}

/* ---- resposta ---- */
function iniciarResposta(m) {
  respondendoA = { id: m.id, autor: m.autor };
  const barra = document.getElementById("barraResposta");
  barra.hidden = false;
  barra.querySelector(".resp-texto").textContent = `Respondendo a ${m.autor}`;
  document.getElementById("entradaMsg").focus();
}
function cancelarResposta() {
  respondendoA = null;
  document.getElementById("barraResposta").hidden = true;
}

/* ---- edição inline ---- */
function iniciarEdicao(el, m, isDM) {
  const corpoTexto = el.querySelector(".msg-texto");
  const original = m.conteudo;
  corpoTexto.innerHTML = `
    <input class="editar-input" value="${original.replace(/"/g, "&quot;")}">
    <div class="editar-dica">Enter para salvar · Esc para cancelar</div>`;
  const inp = corpoTexto.querySelector(".editar-input");
  inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const novo = inp.value.trim();
      if (novo && novo !== original) socket.emit(isDM ? "editar_dm" : "editar_mensagem", { id: m.id, conteudo: novo });
      else corpoTexto.innerHTML = escapar(original) + (m.editada ? ' <span class="editada">(editada)</span>' : "");
    } else if (e.key === "Escape") {
      corpoTexto.innerHTML = escapar(original) + (m.editada ? ' <span class="editada">(editada)</span>' : "");
    }
  });
}

/* ---- reações ---- */
function abrirSeletorEmoji(ev, mid) {
  fecharSeletorEmoji();
  const menu = document.createElement("div");
  menu.className = "emoji-menu";
  menu.id = "emojiMenu";
  EMOJIS_RAPIDOS.forEach((e) => {
    const b = document.createElement("button");
    b.textContent = e;
    b.onclick = () => { socket.emit("alternar_reacao", { id: mid, emoji: e }); fecharSeletorEmoji(); };
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const r = ev.target.getBoundingClientRect();
  menu.style.top = (r.top - 46) + "px";
  menu.style.left = Math.min(r.left, window.innerWidth - 220) + "px";
  setTimeout(() => document.addEventListener("click", fecharSeletorEmoji, { once: true }), 0);
}
function fecharSeletorEmoji() {
  const m = document.getElementById("emojiMenu");
  if (m) m.remove();
}
function desenharReacao(mid, emoji, total, eu) {
  const cont = document.querySelector(`.msg[data-id="${mid}"] .msg-reacoes`);
  if (!cont) return;
  let chip = cont.querySelector(`.reacao[data-emoji="${emoji}"]`);
  if (total <= 0) { if (chip) chip.remove(); return; }
  if (!chip) {
    chip = document.createElement("button");
    chip.className = "reacao";
    chip.dataset.emoji = emoji;
    chip.onclick = () => socket.emit("alternar_reacao", { id: mid, emoji });
    cont.appendChild(chip);
  }
  chip.classList.toggle("eu", !!eu);
  chip.innerHTML = `<span>${emoji}</span> <span class="reacao-num">${total}</span>`;
}
function atualizarReacaoUI(d) {
  const souEu = (d.por_usuario === EU.id);
  const chip = document.querySelector(`.msg[data-id="${d.id}"] .reacao[data-emoji="${d.emoji}"]`);
  const euAtual = chip ? chip.classList.contains("eu") : false;
  // "eu" só muda se fui eu que reagi; senão preserva
  const eu = souEu ? d.adicionou : euAtual;
  desenharReacao(d.id, d.emoji, d.total, eu);
}

/* ---------------- envio ---------------- */
document.getElementById("formEnvio").addEventListener("submit", (e) => {
  e.preventDefault();
  const inp = document.getElementById("entradaMsg");
  const txt = inp.value.trim();
  if (!txt || (!canalAtual && !dmAtual)) return;
  if (dmAtual) {
    socket.emit("enviar_dm", {
      conversa_id: dmAtual, conteudo: txt,
      responde_a: respondendoA ? respondendoA.id : null,
    });
  } else {
    socket.emit("enviar_mensagem", {
      canal_id: canalAtual, conteudo: txt,
      responde_a: respondendoA ? respondendoA.id : null,
    });
  }
  inp.value = "";
  cancelarResposta();
});
document.getElementById("entradaMsg").addEventListener("input", () => {
  if (canalAtual && socket) socket.emit("digitando", { canal_id: canalAtual });
});
document.getElementById("respCancelar").addEventListener("click", cancelarResposta);
document.getElementById("entradaMsg").addEventListener("keydown", (e) => {
  if (e.key === "Escape") cancelarResposta();
});

/* ---------------- criar/entrar servidor ---------------- */
const modalFundo = document.getElementById("modalFundo");
const modal = document.getElementById("modal");
function fecharModal() { modalFundo.hidden = true; modal.innerHTML = ""; }
modalFundo.addEventListener("click", (e) => { if (e.target === modalFundo) fecharModal(); });

document.getElementById("btnNovoServidor").addEventListener("click", () => abrirModalNovoServidor());

const MOLDES_UI = [
  { id: "jogos",   emoji: "🎮", nome: "Jogos" },
  { id: "amigos",  emoji: "💜", nome: "Amigos" },
  { id: "estudos", emoji: "📚", nome: "Grupo de estudos" },
  { id: "escolar", emoji: "🏫", nome: "Clube escolar" },
];

function abrirModalNovoServidor() {
  modalFundo.hidden = false;
  modal.innerHTML = `
    <div class="modal-topo">
      <div>
        <h2>Criar seu servidor</h2>
        <p class="m-sub">Seu servidor é onde você e seus amigos se reúnem. Crie o seu e comece a interagir.</p>
      </div>
      <button class="modal-fechar" id="mFechar" aria-label="Fechar">&times;</button>
    </div>
    <div class="moldes-lista">
      <button class="molde-btn destaque" data-molde="padrao">
        <span class="molde-emoji">✳️</span> Criar o meu
        <span class="molde-seta">&rsaquo;</span>
      </button>
      <div class="molde-sec">Começar de um molde</div>
      ${MOLDES_UI.map(m => `
        <button class="molde-btn" data-molde="${m.id}">
          <span class="molde-emoji">${m.emoji}</span> ${m.nome}
          <span class="molde-seta">&rsaquo;</span>
        </button>`).join("")}
    </div>
    <div class="modal-rodape-conv">
      <p>Já tem um convite?</p>
      <button class="btn-sec" id="mEntrarConvite" style="width:100%">Entrar em um servidor</button>
    </div>`;

  document.getElementById("mFechar").onclick = fecharModal;
  document.getElementById("mEntrarConvite").onclick = abrirModalConvite;
  modal.querySelectorAll(".molde-btn").forEach((b) => {
    b.onclick = () => etapaNomearServidor(b.dataset.molde);
  });
}

function etapaNomearServidor(molde) {
  const rotulo = { jogos: "Jogos", amigos: "Amigos", estudos: "Grupo de estudos",
                   escolar: "Clube escolar", padrao: "Meu servidor" }[molde] || "Meu servidor";
  modal.innerHTML = `
    <div class="modal-topo">
      <div><h2>Personalize seu servidor</h2>
        <p class="m-sub">Dê um nome. Você pode mudar depois.</p></div>
      <button class="modal-fechar" id="mFechar" aria-label="Fechar">&times;</button>
    </div>
    <label>Nome do servidor
      <input id="nomeSrv" maxlength="40" placeholder="Ex: ${rotulo} da galera" value="">
    </label>
    <div class="modal-acoes">
      <button class="btn-sec" id="mVoltar">Voltar</button>
      <button class="btn-pri" id="mCriar">Criar servidor</button>
    </div>`;
  document.getElementById("mFechar").onclick = fecharModal;
  document.getElementById("mVoltar").onclick = abrirModalNovoServidor;
  const inp = document.getElementById("nomeSrv");
  inp.focus();
  document.getElementById("mCriar").onclick = async () => {
    const nome = inp.value.trim() || inp.placeholder.replace("Ex: ", "");
    const { ok, dados } = await jpost("/api/servidores", { nome, molde });
    if (ok) {
      fecharModal();
      await carregarServidores();
      const btn = document.querySelector(`.srv-btn[data-servidor="${dados.id}"]`);
      abrirServidor(dados.id, btn);
    } else alert(dados.erro || "Erro ao criar.");
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("mCriar").click(); });
}

function abrirModalConvite() {
  modalFundo.hidden = false;
  modal.innerHTML = `
    <div class="modal-topo">
      <div><h2>Entrar em um servidor</h2>
        <p class="m-sub">Digite o código do convite que te enviaram.</p></div>
      <button class="modal-fechar" id="mFechar" aria-label="Fechar">&times;</button>
    </div>
    <label>Código do convite
      <input id="codConvite" maxlength="12" placeholder="ex: k4p2mx9a">
    </label>
    <div class="modal-acoes">
      <button class="btn-sec" id="mVoltar">Voltar</button>
      <button class="btn-pri" id="mEntrar">Entrar</button>
    </div>`;
  document.getElementById("mFechar").onclick = fecharModal;
  document.getElementById("mVoltar").onclick = abrirModalNovoServidor;
  const inp = document.getElementById("codConvite");
  inp.focus();
  document.getElementById("mEntrar").onclick = async () => {
    const convite = inp.value.trim();
    if (!convite) return;
    const { ok, dados } = await jpost("/api/servidores/entrar", { convite });
    if (ok) {
      fecharModal();
      await carregarServidores();
      const btn = document.querySelector(`.srv-btn[data-servidor="${dados.id}"]`);
      abrirServidor(dados.id, btn);
    } else alert(dados.erro || "Convite inválido.");
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("mEntrar").click(); });
}

async function criarCanal(sid, categoriaId) {
  const nome = prompt("Nome do novo canal:");
  if (!nome || !nome.trim()) return;
  const { ok, dados } = await jpost(`/api/servidores/${sid}/canais`, { nome: nome.trim(), categoria_id: categoriaId });
  if (ok) abrirServidor(sid, document.querySelector(`.srv-btn[data-servidor="${sid}"]`));
  else alert(dados.erro || "Erro ao criar canal.");
}

/* ---------------- gerenciar cargos ---------------- */
let PERMISSOES_DISPONIVEIS = null;
async function abrirModalCargos(sid) {
  if (!PERMISSOES_DISPONIVEIS) PERMISSOES_DISPONIVEIS = await jget("/api/permissoes");
  const s = await jget(`/api/servidores/${sid}`);
  modalFundo.hidden = false;
  renderModalCargos(sid, s);
}
function renderModalCargos(sid, s) {
  const linhas = s.cargos.map((c) => `
    <div class="cargo-linha">
      <span class="cargo-cor-bola" style="background:${c.cor}"></span>
      <span class="cargo-nome-linha">${escapar(c.nome)}</span>
      <span class="cargo-perms-resumo">${c.permissoes.length ? c.permissoes.length + " permissão(ões)" : "sem permissões"}</span>
      <button class="btn-sec btn-pequeno" data-editar-cargo="${c.id}">Editar</button>
    </div>`).join("") || '<p class="m-sub">Nenhum cargo criado ainda.</p>';
  modal.innerHTML = `
    <div class="modal-topo">
      <h2>Cargos — ${escapar(s.nome)}</h2>
      <button class="modal-fechar" id="mFechar">&times;</button>
    </div>
    <p class="m-sub">Cargos no topo têm mais poder. Você só edita cargos abaixo do seu nível.</p>
    <div class="lista-cargos">${linhas}</div>
    <div class="modal-acoes">
      <button class="btn-pri" id="mNovoCargo" style="width:100%">+ Criar cargo</button>
    </div>`;
  document.getElementById("mFechar").onclick = fecharModal;
  document.getElementById("mNovoCargo").onclick = () => abrirFormCargo(sid, s, null);
  modal.querySelectorAll("[data-editar-cargo]").forEach((b) => {
    b.onclick = () => {
      const cargo = s.cargos.find((c) => c.id == b.dataset.editarCargo);
      abrirFormCargo(sid, s, cargo);
    };
  });
}
function abrirFormCargo(sid, s, cargo) {
  const editando = !!cargo;
  const nome = editando ? cargo.nome : "";
  const cor = editando ? cargo.cor : "#a855f7";
  const permsAtuais = new Set(editando ? cargo.permissoes : []);
  const checks = PERMISSOES_DISPONIVEIS.map((p) => `
    <label class="check-cargo">
      <input type="checkbox" value="${p.chave}" ${permsAtuais.has(p.chave) ? "checked" : ""}>
      <span>${escapar(p.rotulo)}</span>
    </label>`).join("");
  modal.innerHTML = `
    <div class="modal-topo">
      <h2>${editando ? "Editar cargo" : "Novo cargo"}</h2>
      <button class="modal-fechar" id="mFechar">&times;</button>
    </div>
    <div class="campo-duplo-cargo">
      <label>Nome<input id="cargoNome" value="${escapar(nome)}" maxlength="30"></label>
      <label>Cor<input id="cargoCor" type="color" value="${cor}"></label>
    </div>
    <p class="m-sub" style="margin-top:14px">Permissões:</p>
    <div class="lista-checks-cargo">${checks}</div>
    <div class="modal-acoes">
      ${editando ? '<button class="btn-sec" id="mExcluirCargo" style="margin-right:auto;color:var(--coral)">Excluir cargo</button>' : ""}
      <button class="btn-sec" id="mVoltarCargos">Voltar</button>
      <button class="btn-pri" id="mSalvarCargo">${editando ? "Salvar" : "Criar"}</button>
    </div>`;
  document.getElementById("mFechar").onclick = fecharModal;
  document.getElementById("mVoltarCargos").onclick = () => renderModalCargos(sid, s);
  document.getElementById("mSalvarCargo").onclick = async () => {
    const nomeNovo = document.getElementById("cargoNome").value.trim();
    if (!nomeNovo) return;
    const corNova = document.getElementById("cargoCor").value;
    const permissoes = [...modal.querySelectorAll(".check-cargo input:checked")].map((i) => i.value);
    let r;
    if (editando) r = await fetch(`/api/cargos/${cargo.id}`, { method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ nome: nomeNovo, cor: corNova, permissoes }) });
    else r = await fetch(`/api/servidores/${sid}/cargos`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ nome: nomeNovo, cor: corNova, permissoes }) });
    const dados = await r.json();
    if (r.ok) { const s2 = await jget(`/api/servidores/${sid}`); renderModalCargos(sid, s2); abrirServidor(sid, document.querySelector(`.srv-btn[data-servidor="${sid}"]`)); }
    else alert(dados.erro || "Erro ao salvar cargo.");
  };
  if (editando) {
    document.getElementById("mExcluirCargo").onclick = async () => {
      if (!confirm(`Excluir o cargo "${cargo.nome}"?`)) return;
      const r = await fetch(`/api/cargos/${cargo.id}`, { method: "DELETE" });
      const dados = await r.json();
      if (r.ok) { const s2 = await jget(`/api/servidores/${sid}`); renderModalCargos(sid, s2); abrirServidor(sid, document.querySelector(`.srv-btn[data-servidor="${sid}"]`)); }
      else alert(dados.erro || "Erro ao excluir.");
    };
  }
}

/* ---------------- menu de ações do membro ---------------- */
function abrirMenuMembro(ev, sid, membro, cargos, perms) {
  ev.stopPropagation();
  document.querySelectorAll(".menu-membro-flutuante").forEach((m) => m.remove());
  const menu = document.createElement("div");
  menu.className = "menu-membro-flutuante";
  let html = "";
  if (perms.podeGerenciarCargos && cargos.length) {
    const meusCargos = new Set((membro.cargos || []).map((c) => c.id));
    html += `<div class="menu-secao">Atribuir cargo</div>`;
    cargos.forEach((c) => {
      html += `<label class="menu-item-check">
        <input type="checkbox" data-cargo="${c.id}" ${meusCargos.has(c.id) ? "checked" : ""}>
        <span style="color:${c.cor}">${escapar(c.nome)}</span>
      </label>`;
    });
  }
  if (perms.podeExpulsar) html += `<button class="menu-item-acao" data-acao-membro="expulsar">Expulsar do servidor</button>`;
  if (perms.podeBanir) html += `<button class="menu-item-acao perigo" data-acao-membro="banir">Banir do servidor</button>`;
  menu.innerHTML = html || '<div class="menu-secao">Sem ações disponíveis</div>';
  document.body.appendChild(menu);
  const r = ev.target.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + "px";
  menu.style.left = Math.min(r.left - 160, window.innerWidth - 240) + "px";

  menu.querySelectorAll("[data-cargo]").forEach((chk) => {
    chk.addEventListener("change", async () => {
      const cid = chk.dataset.cargo;
      const url = `/api/cargos/${cid}/membros/${membro.id}`;
      const r2 = await fetch(url, { method: chk.checked ? "POST" : "DELETE" });
      if (!r2.ok) { const d = await r2.json(); alert(d.erro || "Erro ao atualizar cargo."); chk.checked = !chk.checked; }
      else abrirServidor(sid, document.querySelector(`.srv-btn[data-servidor="${sid}"]`));
    });
  });
  const btnExp = menu.querySelector('[data-acao-membro="expulsar"]');
  if (btnExp) btnExp.onclick = async () => {
    if (!confirm(`Expulsar ${membro.nome} do servidor?`)) return;
    const r2 = await fetch(`/api/servidores/${sid}/membros/${membro.id}/expulsar`, { method: "POST" });
    const d = await r2.json();
    if (r2.ok) { fecharMenuMembro(); abrirServidor(sid, document.querySelector(`.srv-btn[data-servidor="${sid}"]`)); }
    else alert(d.erro);
  };
  const btnBan = menu.querySelector('[data-acao-membro="banir"]');
  if (btnBan) btnBan.onclick = async () => {
    if (!confirm(`Banir ${membro.nome} do servidor? Ele não poderá reentrar pelo convite.`)) return;
    const r2 = await fetch(`/api/servidores/${sid}/membros/${membro.id}/banir`, { method: "POST", headers: {"Content-Type":"application/json"}, body: "{}" });
    const d = await r2.json();
    if (r2.ok) { fecharMenuMembro(); abrirServidor(sid, document.querySelector(`.srv-btn[data-servidor="${sid}"]`)); }
    else alert(d.erro);
  };
  setTimeout(() => document.addEventListener("click", fecharMenuMembro, { once: true }), 0);
}
function fecharMenuMembro() {
  document.querySelectorAll(".menu-membro-flutuante").forEach((m) => m.remove());
}

function mostrarConvite(codigo) {
  modalFundo.hidden = false;
  modal.innerHTML = `
    <h2>Convite do servidor</h2>
    <p class="m-sub">Compartilhe este código. Quem tiver ele pode entrar pelo botão + &rarr; "Entrar com convite".</p>
    <div class="convite-codigo">${escapar(codigo)}</div>
    <div class="modal-acoes">
      <button class="btn-sec" id="copiar">Copiar</button>
      <button class="btn-pri" id="fechar">Pronto</button>
    </div>`;
  document.getElementById("fechar").onclick = fecharModal;
  document.getElementById("copiar").onclick = () => {
    navigator.clipboard.writeText(codigo).then(() => {
      document.getElementById("copiar").textContent = "Copiado!";
    }).catch(() => {});
  };
}

/* ---------------- som de notificação ---------------- */
let somLigado = true;
try { somLigado = localStorage.getItem("nexus_som") !== "off"; } catch (e) {}

function tocarNotificacao() {
  if (!somLigado) return;
  const a = document.getElementById("somNotif");
  if (!a) return;
  try { a.currentTime = 0; a.play().catch(() => {}); } catch (e) {}
}

function atualizarBotaoSom() {
  const b = document.getElementById("btnSom");
  if (!b) return;
  b.textContent = somLigado ? "🔔" : "🔕";
  b.title = somLigado ? "Som ligado (clique para desligar)" : "Som desligado (clique para ligar)";
  b.classList.toggle("mudo", !somLigado);
}

document.getElementById("btnSom").addEventListener("click", () => {
  somLigado = !somLigado;
  try { localStorage.setItem("nexus_som", somLigado ? "on" : "off"); } catch (e) {}
  atualizarBotaoSom();
  if (somLigado) tocarNotificacao(); // toca uma prévia ao ligar
});
atualizarBotaoSom();

/* ---------------- início ---------------- */
document.querySelector(".srv-btn.inicio").addEventListener("click", mostrarTelaAmigos);

(async function iniciar() {
  conectarSocket();
  registrarEventosDeChamada();
  ligarControlesDeChamada();
  await carregarServidores();
  // sempre começa na tela inicial de Amigos (sem abrir servidor)
  mostrarTelaAmigos();
})();
