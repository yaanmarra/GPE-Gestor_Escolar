document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("loginForm");
  const msg  = document.getElementById("msg");
  const btn  = document.getElementById("btnEntrar");
  const toggle = document.getElementById("toggleSenha");
  const inputSenha = document.getElementById("senha");

  // mostrar/ocultar senha
  toggle.addEventListener("click", () => {
    const isPass = inputSenha.type === "password";
    inputSenha.type = isPass ? "text" : "password";
    toggle.textContent = isPass ? "🙈" : "👁️";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.textContent = "";
    msg.className = "msg";
    btn.classList.add("loading");

    const email = form.email.value.trim();
    const senha = form.senha.value.trim();

    if (!email || !senha) {
      btn.classList.remove("loading");
      msg.textContent = "Preencha e-mail e senha.";
      msg.classList.add("err");
      return;
    }

    try {
      const resp = await fetch(`${API_BASE_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, senha })
      });

      const data = await resp.json();

      if (!resp.ok || !data.sucesso) {
        throw new Error(data.erro || "Falha no login.");
      }

      // salva tokens e sessão
      if (typeof setTokens === 'function') {
        setTokens(data.dados.accessToken, data.dados.refreshToken);
      }
      localStorage.setItem("usuario_id", data.dados.usuario.id);
      localStorage.setItem("nome", data.dados.usuario.nome);
      localStorage.setItem("tipo", data.dados.usuario.tipo);

      msg.textContent = "Login feito com sucesso!";
      msg.classList.add("ok");

      const rotas = {
        "aluno": "aluno.html",
        "pai": "pais.html",
        "professor": "professor.html",
        "gestor": "gestor.html"
      };

      setTimeout(() => {
        window.location.href = rotas[data.dados.usuario.tipo] || "index.html";
      }, 400);

    } catch (err) {
      console.error(err);
      msg.textContent = err.message || "Erro ao conectar.";
      msg.classList.add("err");
    } finally {
      btn.classList.remove("loading");
    }
  });
});
