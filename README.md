# Nexus — plataforma de comunicação e comunidades

Chat de comunidades em tempo real: servidores, categorias, canais de texto e
mensagens instantâneas (WebSocket). Feito em Flask + Flask-SocketIO, com
identidade visual própria.

Esta é a **fatia 1** (o MVP que a própria especificação manda priorizar:
autenticação, usuários, servidores, canais e mensagens). Voz, vídeo,
compartilhamento de tela e transmissão de jogos NÃO fazem parte desta fatia —
eles exigem infraestrutura de tempo real (WebRTC, servidores de mídia) que só
faz sentido depois, com hospedagem.

---

## Como rodar no seu PC

Requer Python 3.10+.

```bash
pip install -r requirements.txt
# No Arch, se reclamar: pip install -r requirements.txt --break-system-packages

python app.py
```

Acesse **http://127.0.0.1:5000**

Conta de teste já criada: usuário **demo**, senha **demo1234**.
Ou clique em "Criar conta" para fazer a sua (você já ganha um servidor próprio).

---

## O que funciona

- **Login e cadastro** com senha protegida por hash.
- **Sistema de amigos completo**: adicionar por nome de usuário, aceitar/recusar pedidos, remover, bloquear/desbloquear.
- **Status online/offline em tempo real** entre amigos.
- **Mensagens diretas (DM)**: converse com qualquer amigo, com reposta, edição e exclusão (tudo em tempo real, igual aos canais de servidor).
- **Servidores (comunidades)**: comece sem nenhum; crie pelo modal com moldes (Jogos, Amigos, Grupo de estudos, Clube escolar), cada um com canais próprios, ou entre por convite.
- **Categorias e canais de texto** organizados na barra lateral.
- **Mensagens em tempo real**: quem está no mesmo canal recebe na hora, sem
  recarregar a página (WebSocket). As mensagens ficam salvas no banco.
- **Indicador de "está digitando"**.
- **Lista de membros** com papéis (dono, admin, membro).
- **Convites**: cada servidor tem um código; quem tiver, entra.
- Interface responsiva com identidade própria (tema escuro preto/roxo/cinza).

---

## Testar o tempo real sozinho

Abra o **http://127.0.0.1:5000** em duas janelas (ou dois navegadores):
uma logada como `demo` e outra numa conta nova. Entre no mesmo servidor/canal e
mande mensagens — elas aparecem nas duas na hora.

Para dois computadores diferentes conversarem, é preciso **hospedar** o Nexus
(próxima etapa). Rodando local, o acesso é só na sua máquina.

---

## Estrutura

```
nexus/
├── app.py            Servidor: rotas HTTP + eventos WebSocket (tempo real)
├── database.py       Banco de dados (usuários, servidores, canais, mensagens)
├── requirements.txt
├── templates/
│   ├── entrar.html   Tela de login/cadastro
│   └── app.html      Aplicação principal (4 colunas)
└── static/
    ├── css/          auth.css (login) e app.css (aplicação)
    └── js/           app.js (front) e socket.io.min.js (cliente de tempo real)
```

---

## Próximas etapas (roadmap)

Seguindo a ordem que a própria especificação recomenda:

1. **Hospedar** para os amigos acessarem por um link (serviço grátis para
   começar + banco de dados). É o passo que transforma "roda no meu PC" em
   "meus amigos usam".
2. Cargos e permissões mais completos (quem pode ver/escrever em cada canal).
3. Reações, respostas, edição/exclusão de mensagens, anexos de imagem.
4. Mensagens diretas (DM) e grupos privados.
5. Voz e vídeo (WebRTC) — a parte mais pesada, exige infraestrutura dedicada.

---

## Antes de hospedar (segurança)

- Em `app.py`, defina a variável de ambiente `NEXUS_SECRET` com um valor
  secreto e aleatório (não deixe a chave padrão).
- Rode atrás de um servidor apropriado para produção (o servidor embutido é de
  desenvolvimento).
- As senhas já são guardadas com hash; nunca são exibidas nem retornadas pela API.
