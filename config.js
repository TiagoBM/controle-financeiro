// Configuração da sincronização na nuvem (Supabase).
// Pegue estes dois valores em: Supabase > seu projeto > Project Settings > API
// (ou no botão "Connect" do painel). A chave "anon"/"publishable" é pública por natureza:
// quem protege os dados são as regras de segurança (RLS) criadas pelo schema.sql.
// Deixe como está para usar o app só neste navegador, sem nuvem.
window.FINANCEIRO_CONFIG = {
  supabaseUrl: "https://bpiuzdpvqezmcojafvjm.supabase.co",
  supabaseAnonKey: "sb_publishable_Be2ISJAd3eo5z6aKd7f6dg_RTMXWr8H",
};
