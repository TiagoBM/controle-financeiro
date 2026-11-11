# Controle financeiro

App web para controlar gastos: tipos de gasto, cartões, valores e parcelas, com sincronização na nuvem (Supabase) entre computadores e celular.

**Acesse:** https://tiagobm.github.io/controle-financeiro/

## Recursos

- **Tipos de gasto**: categorias com cor e orçamento mensal opcional (alerta quando passar).
- **Cartões**: nome, dia de fechamento, dia de vencimento, limite e cor. Compras feitas a partir do dia de fechamento entram na fatura do mês seguinte; o limite usado considera as parcelas ainda a pagar.
- **Gastos**: descrição, tipo, cartão (ou sem cartão: dinheiro, Pix, débito), data, parcelas e valor (total ou por parcela).
- **Resumo do mês**: total, divisão por tipo e por cartão (fatura), parcelas do mês com filtros, CSV e previsão dos próximos 12 meses.
- **Lançamentos**: busca, filtros, valor restante, edição, duplicação e exclusão.
- **Backup**: exportar/importar `.json`.
- **Nuvem**: login com e-mail e senha; os dados aparecem iguais em todos os aparelhos e se atualizam em tempo real. Sem internet o app continua funcionando e envia as alterações quando a conexão voltar.

## Arquivos

- `index.html`, `financeiro.css`, `financeiro.js`: o app (HTML, CSS e JavaScript puros, sem build).
- `config.js`: endereço e chave pública (publishable) do projeto Supabase.
- `supabase/schema.sql`: tabelas, regras de segurança (cada usuário só acessa os próprios dados) e tempo real. Rode no **SQL Editor** do Supabase.
- `vendor/supabase.js`: biblioteca `@supabase/supabase-js` 2.118.0 (licença MIT).

## Configurar um projeto Supabase do zero

1. Crie um projeto em [supabase.com](https://supabase.com).
2. **SQL Editor → New query**: cole `supabase/schema.sql` e clique em **Run**.
3. **Authentication → Sign In / Providers → Email**: desligue **Confirm email** (uso pessoal).
4. Copie a **Project URL** e a chave **publishable** (botão **Connect**) para `config.js`. Nunca use a chave `secret`/`service_role`.
5. Depois de criar sua conta no app, desligue **Allow new users to sign up** para ninguém mais criar contas.
