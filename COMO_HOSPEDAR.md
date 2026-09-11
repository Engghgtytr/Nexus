# Como colocar o Nexus no ar (Render) — passo a passo

Ao final, seus amigos vão acessar o Nexus por um link tipo
`https://nexus-xxxx.onrender.com` de qualquer computador ou celular.

Você faz isto UMA vez. Depois é só usar o link.
Tempo: ~1 hora na primeira vez (a maior parte é criar contas).

O código já está pronto para hospedagem: ele usa PostgreSQL quando está no
Render (dados não se perdem) e SQLite quando roda no seu PC (para testes).

---

## VISÃO GERAL

1. Subir o código para o GitHub.
2. Criar conta no Render.
3. O Render lê o arquivo `render.yaml` e monta tudo sozinho (site + banco).
4. Sai um link. Pronto.

---

## PARTE 1 — Colocar o código no GitHub

1. Crie uma conta grátis em https://github.com (se ainda não tiver).

2. Instale o Git no Windows: no PowerShell, rode
   `winget install Git.Git`
   Depois FECHE e REABRA o PowerShell.

3. No GitHub, clique no `+` (canto superior direito) > **New repository**.
   - Repository name: `nexus`
   - Deixe como **Private** (só você vê) ou Public, tanto faz.
   - NÃO marque "Add a README".
   - Clique em **Create repository**.

4. Na tela seguinte, o GitHub mostra um endereço tipo
   `https://github.com/SEU_USUARIO/nexus.git`. Copie ele.

5. No PowerShell, entre na pasta do Nexus e suba o código
   (troque a URL pela que você copiou):

   ```powershell
   cd "C:\Users\Aluno\Downloads\nexus_deploy\nexus"
   git init
   git add .
   git commit -m "Nexus - primeira versao"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/nexus.git
   git push -u origin main
   ```

   Na primeira vez, o Git vai pedir para você fazer login no GitHub
   (abre uma janela no navegador). Faça o login e autorize.

---

## PARTE 2 — Criar o serviço no Render

1. Crie conta em https://render.com — clique em **Get Started** e escolha
   **Sign in with GitHub** (mais fácil, já conecta as duas contas).

2. No painel do Render, clique em **New +** > **Blueprint**.
   (Blueprint é o modo que lê o arquivo `render.yaml` do seu projeto.)

3. Conecte/escolha o repositório `nexus` que você acabou de subir.

4. O Render vai ler o `render.yaml` e mostrar que vai criar:
   - um serviço web chamado **nexus**
   - um banco de dados chamado **nexus-db**
   Clique em **Apply** / **Create**.

5. Espere alguns minutos (ele instala tudo e liga). Quando terminar,
   aparece o link do seu Nexus, tipo `https://nexus-xxxx.onrender.com`.

6. Abra o link. A tela de login do Nexus deve aparecer.
   Crie sua conta e mande o link para os amigos.

---

## COISAS IMPORTANTES DE SABER

- **O plano grátis "dorme".** Se ninguém usa por ~15 minutos, o servidor
  hiberna. O primeiro acesso depois disso demora ~30-50 segundos para
  "acordar". Depois fica normal. É o preço do plano grátis.

- **A conta demo (demo/demo1234)** é criada automaticamente. Depois de testar,
  vale trocar a senha ou criar sua conta de verdade.

- **Segurança:** o `render.yaml` já gera uma chave secreta automática
  (NEXUS_SECRET) — você não precisa fazer nada.

- **Atualizar o Nexus depois:** quando a gente mudar algo no código, você roda:
  ```powershell
  git add .
  git commit -m "novidades"
  git push
  ```
  O Render detecta e atualiza sozinho em alguns minutos.

---

## DEPOIS: domínio próprio (opcional)

Quando o Nexus estiver no ar e você comprar um domínio, dá para trocar o
endereço `.onrender.com` pelo seu (`nexus.seudominio.com`). No Render:
Settings > Custom Domains > Add. Ele te dá as instruções de DNS.
Confira o preço de RENOVAÇÃO do domínio antes de comprar (não só o 1º ano).

---

## SE DER PROBLEMA

- **"git não é reconhecido"** → não reabriu o PowerShell depois de instalar o Git.
- **Erro no push do GitHub** → confira se a URL do `git remote` está certa
  (com seu usuário) e se você fez login quando pediu.
- **O site abre mas dá erro 500** → veja os logs no painel do Render
  (aba "Logs" do serviço nexus) e me mande o que aparecer.
- **Demora muito no primeiro acesso** → é o "sono" do plano grátis, normal.
