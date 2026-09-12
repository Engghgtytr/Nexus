/* ===========================================================
   Nexus — Chamadas (voz, vídeo e compartilhamento de tela)
   WebRTC "mesh": cada participante conecta diretamente com os
   outros. O servidor (Socket.IO) só entrega convites e repassa
   as mensagens de sinalização — o áudio/vídeo nunca passa por ele.
   =========================================================== */

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const RESOLUCOES_TELA = {
  "1080p": { width: { ideal: 1920 }, height: { ideal: 1080 } },
  "4k": { width: { ideal: 3840 }, height: { ideal: 2160 } },
};
const FPS_TELA = { "60": 60, "144": 144 };

const Chamada = {
  ativa: false,
  id: null,
  tipo: "video",
  meuStream: null,        // câmera + microfone
  streamTela: null,       // compartilhamento de tela (separado)
  peers: {},              // usuario_id -> RTCPeerConnection
  streamsRemotos: {},     // usuario_id -> MediaStream
  infoParticipantes: {},  // usuario_id -> {nome, cor, usuario}
  microfoneOn: true,
  cameraOn: false,
  compartilhandoTela: false,
  dispositivoCamId: null,
  dispositivoMicId: null,
  resolucaoTela: "1080p",
  fpsTela: "60",
};

/* ---------------- dispositivos ---------------- */
async function listarDispositivos() {
  try {
    // pede permissão mínima uma vez, senão o navegador não revela os nomes dos aparelhos
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (e) { /* usuário pode negar; a lista vem sem nomes, mas não quebra */ }
  const dispositivos = await navigator.mediaDevices.enumerateDevices();
  return {
    cameras: dispositivos.filter((d) => d.kind === "videoinput"),
    microfones: dispositivos.filter((d) => d.kind === "audioinput"),
  };
}

/* ---------------- iniciar / entrar ---------------- */
function chamadaIniciar(paraId, tipo) {
  socket.emit("chamada_iniciar", { para_id: paraId, tipo });
}

async function chamadaAceitar(cid) {
  await prepararMidiaLocal();
  socket.emit("chamada_aceitar", { chamada_id: cid });
}

function chamadaRecusar(cid) {
  socket.emit("chamada_recusar", { chamada_id: cid });
}

async function prepararMidiaLocal() {
  const constraints = {
    audio: Chamada.dispositivoMicId ? { deviceId: { exact: Chamada.dispositivoMicId } } : true,
    video: false, // câmera começa desligada; a pessoa liga quando quiser (como no Discord)
  };
  try {
    Chamada.meuStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    Chamada.meuStream = new MediaStream(); // segue sem áudio se o usuário negar
    console.warn("Não foi possível acessar o microfone:", e);
  }
}

/* ---------------- conexão com um participante ---------------- */
function criarConexaoCom(uid) {
  if (Chamada.peers[uid]) return Chamada.peers[uid];
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  Chamada.peers[uid] = pc;

  // envia minhas trilhas atuais (mic/câmera/tela) pra esse novo peer
  const stream = new MediaStream();
  if (Chamada.meuStream) Chamada.meuStream.getTracks().forEach((t) => stream.addTrack(t));
  if (Chamada.streamTela) Chamada.streamTela.getTracks().forEach((t) => stream.addTrack(t));
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("webrtc_sinal", {
        chamada_id: Chamada.id, para_id: uid, tipo: "candidato",
        dados: e.candidate,
      });
    }
  };

  pc.ontrack = (e) => {
    Chamada.streamsRemotos[uid] = e.streams[0];
    renderizarTiles();
  };

  pc.onnegotiationneeded = async () => {
    try {
      const oferta = await pc.createOffer();
      await pc.setLocalDescription(oferta);
      socket.emit("webrtc_sinal", { chamada_id: Chamada.id, para_id: uid, tipo: "oferta", dados: oferta });
    } catch (e) { console.warn("Falha ao renegociar conexão:", e); }
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      // não força saída; deixa a UI mostrar reconectando. Falha real cai no timeout do ICE.
    }
  };

  // se não há nenhuma trilha (ex: microfone negado), força uma negociação
  // mesmo assim, criando um canal vazio — garante que a conexão é tentada.
  if (stream.getTracks().length === 0) {
    pc.createDataChannel("_neg");
  }

  return pc;
}

async function conectarComoOfertante(uid) {
  // criar a conexão já adiciona as trilhas, o que dispara 'negotiationneeded'
  // no navegador sozinho — é ele quem cria e envia a oferta.
  criarConexaoCom(uid);
}

/* ---------------- eventos de sinalização recebidos ---------------- */
function registrarEventosDeChamada() {
  socket.on("chamada_recebida", (d) => mostrarConviteRecebido(d));

  socket.on("chamada_criada", (d) => {
    Chamada.ativa = true; Chamada.id = d.chamada_id; Chamada.tipo = d.tipo;
    abrirTelaDeChamada();
    if (d.tipo === "video" && !Chamada.cameraOn) alternarCamera();
  });

  socket.on("chamada_entrou", async (d) => {
    Chamada.ativa = true; Chamada.id = d.chamada_id; Chamada.tipo = d.tipo;
    d.participantes.forEach((p) => { Chamada.infoParticipantes[p.id] = p; });
    abrirTelaDeChamada();
    if (d.tipo === "video" && !Chamada.cameraOn) await alternarCamera();
    // eu que acabei de entrar: conecto com quem já estava (sou o ofertante)
    for (const p of d.participantes) {
      if (p.id !== EU.id) await conectarComoOfertante(p.id);
    }
  });

  socket.on("chamada_participante_entrou", (d) => {
    Chamada.infoParticipantes[d.usuario.id] = d.usuario;
    renderizarTiles();
    // quem já estava espera a oferta de quem entrou (não ofertamos os dois lados)
  });

  socket.on("chamada_participante_saiu", (d) => {
    const pc = Chamada.peers[d.usuario_id];
    if (pc) { pc.close(); delete Chamada.peers[d.usuario_id]; }
    delete Chamada.streamsRemotos[d.usuario_id];
    delete Chamada.infoParticipantes[d.usuario_id];
    renderizarTiles();
    if (d.usuario_id === EU.id) encerrarChamadaLocalmente();
  });

  socket.on("chamada_recusada", () => {
    fecharConviteRecebido();
  });

  socket.on("chamada_erro", (d) => {
    alert(d.erro);
  });

  socket.on("webrtc_sinal", async (d) => {
    const pc = criarConexaoCom(d.de_id);
    if (d.tipo === "oferta") {
      await pc.setRemoteDescription(new RTCSessionDescription(d.dados));
      const resposta = await pc.createAnswer();
      await pc.setLocalDescription(resposta);
      socket.emit("webrtc_sinal", { chamada_id: Chamada.id, para_id: d.de_id, tipo: "resposta", dados: resposta });
    } else if (d.tipo === "resposta") {
      await pc.setRemoteDescription(new RTCSessionDescription(d.dados));
    } else if (d.tipo === "candidato") {
      try { await pc.addIceCandidate(new RTCIceCandidate(d.dados)); } catch (e) {}
    }
  });
}

/* ---------------- UI: convite recebido ---------------- */
function mostrarConviteRecebido(d) {
  const existente = document.getElementById("convitesChamada");
  const box = document.createElement("div");
  box.className = "convite-chamada";
  box.dataset.chamada = d.chamada_id;
  const cor = d.de.cor && d.de.cor !== "#a855f7" ? d.de.cor : corDe(d.de.nome);
  box.innerHTML = `
    <span class="convite-avatar" style="background:${cor}">${iniciais(d.de.nome)}</span>
    <div class="convite-texto">
      <strong>${escapar(d.de.nome)}</strong>
      <span>${d.tipo === "video" ? "Chamada de vídeo" : "Chamada de voz"}${d.participantes.length > 1 ? " · grupo" : ""}</span>
    </div>
    <button class="btn-pri btn-pequeno" data-aceitar>Aceitar</button>
    <button class="btn-sec btn-pequeno" data-recusar>Recusar</button>`;
  box.querySelector("[data-aceitar]").onclick = async () => {
    box.remove();
    await chamadaAceitar(d.chamada_id);
  };
  box.querySelector("[data-recusar]").onclick = () => {
    box.remove();
    chamadaRecusar(d.chamada_id);
  };
  existente.appendChild(box);
}
function fecharConviteRecebido() {
  document.querySelectorAll(".convite-chamada").forEach((b) => b.remove());
}

/* ---------------- UI: tela de chamada ---------------- */
function abrirTelaDeChamada() {
  document.getElementById("telaChamada").hidden = false;
  renderizarTiles();
}

function renderizarTiles() {
  const cont = document.getElementById("tilesChamada");
  cont.innerHTML = "";
  cont.appendChild(criarTile(EU.id, "Você", Chamada.meuStream, Chamada.streamTela, true));
  Object.keys(Chamada.streamsRemotos).forEach((uid) => {
    const info = Chamada.infoParticipantes[uid] || { nome: "Participante" };
    cont.appendChild(criarTile(uid, info.nome, Chamada.streamsRemotos[uid], null, false));
  });
}

function criarTile(uid, nome, streamCam, streamTela, souEu) {
  const el = document.createElement("div");
  el.className = "tile-chamada";
  const cor = corDe(nome);
  const semVideo = !streamCam || streamCam.getVideoTracks().length === 0;
  el.innerHTML = `
    ${semVideo ? `<span class="tile-avatar" style="background:${cor}">${iniciais(nome)}</span>` : `<video autoplay playsinline ${souEu ? "muted" : ""}></video>`}
    <span class="tile-nome">${escapar(nome)}${souEu ? " (você)" : ""}</span>`;
  if (!semVideo) {
    const v = el.querySelector("video");
    v.srcObject = streamCam;
  }
  return el;
}

/* ---------------- controles: mic, câmera, tela ---------------- */
function alternarMicrofone() {
  Chamada.microfoneOn = !Chamada.microfoneOn;
  if (Chamada.meuStream) Chamada.meuStream.getAudioTracks().forEach((t) => (t.enabled = Chamada.microfoneOn));
  atualizarBotoesControle();
}

async function alternarCamera() {
  Chamada.cameraOn = !Chamada.cameraOn;
  if (Chamada.cameraOn) {
    const constraints = { video: Chamada.dispositivoCamId ? { deviceId: { exact: Chamada.dispositivoCamId } } : true };
    try {
      const novo = await navigator.mediaDevices.getUserMedia(constraints);
      const trilha = novo.getVideoTracks()[0];
      Chamada.meuStream.addTrack(trilha);
      Object.values(Chamada.peers).forEach((pc) => pc.addTrack(trilha, Chamada.meuStream));
    } catch (e) {
      alert("Não foi possível acessar a câmera.");
      Chamada.cameraOn = false;
    }
  } else {
    Chamada.meuStream.getVideoTracks().forEach((t) => {
      t.stop();
      Chamada.meuStream.removeTrack(t);
      Object.values(Chamada.peers).forEach((pc) => {
        const sender = pc.getSenders().find((s) => s.track === t);
        if (sender) pc.removeTrack(sender);
      });
    });
  }
  renderizarTiles();
  atualizarBotoesControle();
}

async function alternarCompartilharTela() {
  if (Chamada.compartilhandoTela) {
    if (Chamada.streamTela) Chamada.streamTela.getTracks().forEach((t) => t.stop());
    Chamada.streamTela = null;
    Chamada.compartilhandoTela = false;
    atualizarBotoesControle();
    return;
  }
  const dims = RESOLUCOES_TELA[Chamada.resolucaoTela];
  const fps = FPS_TELA[Chamada.fpsTela];
  try {
    Chamada.streamTela = await navigator.mediaDevices.getDisplayMedia({
      video: { ...dims, frameRate: { ideal: fps } },
      audio: false,
    });
    const trilha = Chamada.streamTela.getVideoTracks()[0];
    Object.values(Chamada.peers).forEach((pc) => pc.addTrack(trilha, Chamada.streamTela));
    trilha.onended = () => { Chamada.compartilhandoTela = false; Chamada.streamTela = null; atualizarBotoesControle(); };
    Chamada.compartilhandoTela = true;
  } catch (e) {
    console.warn("Compartilhamento de tela cancelado ou não suportado:", e);
  }
  atualizarBotoesControle();
}

function atualizarBotoesControle() {
  const bMic = document.getElementById("btnAlternarMic");
  const bCam = document.getElementById("btnAlternarCam");
  const bTela = document.getElementById("btnAlternarTela");
  if (bMic) { bMic.classList.toggle("ativo", Chamada.microfoneOn); bMic.textContent = Chamada.microfoneOn ? "🎤" : "🔇"; }
  if (bCam) { bCam.classList.toggle("ativo", Chamada.cameraOn); bCam.textContent = Chamada.cameraOn ? "📹" : "📷"; }
  if (bTela) bTela.classList.toggle("ativo", Chamada.compartilhandoTela);
}

/* ---------------- adicionar pessoa / sair ---------------- */
async function abrirAdicionarPessoa() {
  const amigos = (await jget("/api/amigos")).amigos || [];
  const jaNaChamada = new Set(Object.keys(Chamada.streamsRemotos).map(Number));
  jaNaChamada.add(EU.id);
  const disponiveis = amigos.filter((a) => !jaNaChamada.has(a.id));
  modalFundo.hidden = false;
  modal.innerHTML = `
    <div class="modal-topo"><h2>Adicionar à chamada</h2><button class="modal-fechar" id="mFechar">&times;</button></div>
    ${disponiveis.length === 0 ? '<p class="m-sub">Todos os seus amigos já estão na chamada, ou você não tem mais amigos disponíveis.</p>' : ""}
    <div class="lista-amigos">
      ${disponiveis.map((a) => `
        <div class="amigo-card">
          <span class="amigo-avatar" style="background:${corDe(a.nome)}">${iniciais(a.nome)}</span>
          <div class="amigo-info"><span class="amigo-nome">${escapar(a.nome)}</span></div>
          <button class="btn-pri btn-pequeno" data-add="${a.id}">Chamar</button>
        </div>`).join("")}
    </div>`;
  document.getElementById("mFechar").onclick = fecharModal;
  modal.querySelectorAll("[data-add]").forEach((b) => {
    b.onclick = () => {
      socket.emit("chamada_convidar", { chamada_id: Chamada.id, para_id: parseInt(b.dataset.add) });
      b.textContent = "Chamando...";
      b.disabled = true;
    };
  });
}

function sairDaChamada() {
  socket.emit("chamada_sair", { chamada_id: Chamada.id });
  encerrarChamadaLocalmente();
}

function encerrarChamadaLocalmente() {
  Object.values(Chamada.peers).forEach((pc) => pc.close());
  if (Chamada.meuStream) Chamada.meuStream.getTracks().forEach((t) => t.stop());
  if (Chamada.streamTela) Chamada.streamTela.getTracks().forEach((t) => t.stop());
  Chamada.ativa = false; Chamada.id = null;
  Chamada.peers = {}; Chamada.streamsRemotos = {}; Chamada.infoParticipantes = {};
  Chamada.cameraOn = false; Chamada.compartilhandoTela = false;
  document.getElementById("telaChamada").hidden = true;
}

function ligarControlesDeChamada() {
  document.getElementById("btnAlternarMic").onclick = alternarMicrofone;
  document.getElementById("btnAlternarCam").onclick = alternarCamera;
  document.getElementById("btnAlternarTela").onclick = alternarCompartilharTela;
  document.getElementById("btnConfigChamada").onclick = abrirConfigChamada;
  document.getElementById("btnSairChamada").onclick = sairDaChamada;
  document.getElementById("btnAdicionarPessoa").onclick = abrirAdicionarPessoa;
  document.getElementById("btnLigarVoz").onclick = async () => {
    if (!amigoDaConversaAtual) return;
    await prepararMidiaLocal();
    chamadaIniciar(amigoDaConversaAtual.id, "audio");
  };
  document.getElementById("btnLigarVideo").onclick = async () => {
    if (!amigoDaConversaAtual) return;
    await prepararMidiaLocal();
    chamadaIniciar(amigoDaConversaAtual.id, "video");
  };
}

async function abrirConfigChamada() {
  const { cameras, microfones } = await listarDispositivos();
  modalFundo.hidden = false;
  modal.innerHTML = `
    <div class="modal-topo"><h2>Configurações de chamada</h2><button class="modal-fechar" id="mFechar">&times;</button></div>
    <label>Microfone
      <select id="selMic">
        ${microfones.map((d, i) => `<option value="${d.deviceId}">${escapar(d.label || "Microfone " + (i + 1))}</option>`).join("")}
      </select>
    </label>
    <label>Câmera
      <select id="selCam">
        ${cameras.map((d, i) => `<option value="${d.deviceId}">${escapar(d.label || "Câmera " + (i + 1))}</option>`).join("")}
      </select>
    </label>
    <p class="m-sub" style="margin-top:14px">Compartilhamento de tela</p>
    <div class="campo-duplo-cargo">
      <label>Resolução
        <select id="selResolucao">
          <option value="1080p" ${Chamada.resolucaoTela === "1080p" ? "selected" : ""}>1080p (Full HD)</option>
          <option value="4k" ${Chamada.resolucaoTela === "4k" ? "selected" : ""}>4K (Ultra HD)</option>
        </select>
      </label>
      <label>Taxa de quadros
        <select id="selFps">
          <option value="60" ${Chamada.fpsTela === "60" ? "selected" : ""}>60 fps</option>
          <option value="144" ${Chamada.fpsTela === "144" ? "selected" : ""}>144 fps</option>
        </select>
      </label>
    </div>
    <p class="m-sub" style="margin-top:10px">A qualidade final depende do seu monitor e da sua internet — o Nexus pede esses valores ao navegador, mas quem confirma é o seu hardware.</p>
    <div class="modal-acoes"><button class="btn-pri" id="mSalvarConfig" style="width:100%">Salvar</button></div>`;
  document.getElementById("mFechar").onclick = fecharModal;
  if (Chamada.dispositivoMicId) document.getElementById("selMic").value = Chamada.dispositivoMicId;
  if (Chamada.dispositivoCamId) document.getElementById("selCam").value = Chamada.dispositivoCamId;
  document.getElementById("mSalvarConfig").onclick = () => {
    Chamada.dispositivoMicId = document.getElementById("selMic").value || null;
    Chamada.dispositivoCamId = document.getElementById("selCam").value || null;
    Chamada.resolucaoTela = document.getElementById("selResolucao").value;
    Chamada.fpsTela = document.getElementById("selFps").value;
    fecharModal();
  };
}
