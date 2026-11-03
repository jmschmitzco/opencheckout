# Guia em português

Este arquivo é para o Julio. O resto do projeto está em inglês de propósito,
porque projeto open source sem inglês não atrai contribuidor nem cliente de
fora. Aqui fica a explicação de tudo, em português simples.

---

## 1. O que é esse projeto

É um **checkout pronto que o cliente instala no servidor dele**. Nada a ver com
a Mitzshop: lá você vende os produtos dos seus clientes. Aqui você entrega a
máquina de vender e quem usa é outra empresa.

O público é SaaS, ou seja, empresa que cobra mensalidade por um sistema.
Exemplo: uma empresa que vende um programa de gestão por R$ 97 por mês. Ela
precisa de tela de pagamento, cobrança todo mês, cartão recusado, cancelamento,
nota de quem pagou. Isso tudo é trabalho repetido que toda empresa dessas
refaz do zero. O OpenCheckout entrega pronto.

**Quem fica com o dinheiro:** o cliente, sempre. Cada empresa cadastra a chave
do Asaas, do Pagar.me ou do Mercado Pago dela, e o dinheiro cai na conta dela.
O projeto nunca segura dinheiro de ninguém. Isso é a mesma regra que você já
tem na Mitzshop, e vale aqui pelo mesmo motivo: segurar dinheiro de terceiro é
atividade regulada.

**White label** quer dizer que a tela não tem a nossa cara. A empresa coloca o
logo dela, a cor dela, o texto dela, e o comprador nunca sabe que existe um
OpenCheckout no meio. Tem até um nível a mais: se a empresa cliente também
revende para os clientes DELA, cada um pode ter a própria marca na mesma tela,
sem precisar criar uma conta nova para cada um.

---

## 2. Como ver funcionando agora

Abra o terminal na pasta `opencheckout` e rode:

```bash
npm install
```

```bash
npm run demo
```

Depois abra <http://localhost:3000/demo> no navegador.

Não precisa de banco de dados, não precisa de chave de gateway, não precisa
configurar nada. O banco fica na memória e some quando você fecha. O gateway é
simulado, então nenhum pagamento real acontece.

Na página da demo tem cinco botões:

| Botão | O que mostra |
|---|---|
| One-off payment | Compra única, com dois itens e preço riscado |
| Subscription | Assinatura mensal, só cartão |
| White label | A MESMA tela vestida de outra marca |
| Dark theme | A mesma tela no escuro |
| Embedded widget | A tela abrindo por cima do site de outra pessoa |

Cartões de teste:

- `4242 4242 4242 4242` aprova (qualquer data futura, qualquer código)
- `4000 0000 0000 0002` recusa

Pix e boleto compensam sozinhos em uns 12 segundos. Vale a pena ver: aparece um
QR code de verdade, a tela fica esperando, e sozinha ela confirma e manda o
comprador de volta para o site.

---

## 3. Como o cliente usa isso no sistema dele

São três passos. O terceiro é o que importa.

**Passo 1.** O servidor do cliente pede uma sessão de checkout, mandando o que
está sendo vendido e para onde mandar o comprador depois:

```
POST /v1/checkout/sessions
```

**Passo 2.** A resposta vem com um endereço. O cliente manda o comprador para
lá. Essa é a tela de pagamento, com a marca dele.

**Passo 3.** Quando o pagamento confirma, o OpenCheckout **avisa o servidor do
cliente**, com uma assinatura que prova que o aviso veio da gente. É esse aviso
que libera o acesso, nunca o navegador do comprador.

O terceiro passo é a regra mais importante do projeto inteiro, e é a mesma que
você já aprendeu na Mitzshop: **pagamento só é confirmado por webhook ou por
consulta nossa ao gateway**. O navegador pode mentir.

---

## 4. O que está pronto

- Tela de pagamento completa, com cartão parcelado, Pix, boleto e PayPal
- Assinatura mensal, com renovação automática e nova tentativa quando o cartão
  recusa
- Portal do cliente, onde o comprador cancela sozinho e vê as faturas
- Cupom de desconto
- Carrinho abandonado
- Personalização visual completa (o white label)
- Widget para abrir por cima do site do cliente
- API inteira, com chave de teste e chave de produção separadas
- Avisos assinados, com nova tentativa quando o servidor do cliente está fora
- Vários clientes no mesmo servidor, sem um enxergar o outro
- **Os quatro gateways de verdade**: Asaas, Pagar.me, Mercado Pago e PayPal,
  portados do que já roda em produção na Mitzshop
- 293 testes passando, incluindo os de três auditorias que eu mesmo fiz
  (`docs/AUDITS.md` conta o que estava errado e por que importava)

### O que ainda falta

Está tudo anotado em `docs/ROADMAP.md`. Os quatro principais, em ordem de
importância:

1. **Order bump e upsell pós-compra.** Você pediu na primeira versão e eu não
   entreguei. A tabela `offers` está no banco, mas ainda não existe a caixinha
   dentro do checkout nem a tela de um clique depois do pagamento. A metade
   difícil já está feita, porque cobrar com o cartão salvo é o mesmo caminho
   que a renovação de assinatura usa.
2. **O painel da empresa cliente.** Hoje tudo é por API. Falta a tela onde ela
   cola a chave do gateway, escolhe as cores e vê as vendas.
3. **Cartão pelo Mercado Pago.** O adaptador já sabe cobrar, mas o Mercado Pago
   exige que o cartão vire token no NAVEGADOR, com a chave pública deles. Até a
   página fazer isso, o cartão não é oferecido por esse gateway, de propósito:
   melhor não oferecer do que oferecer e falhar no fim do preenchimento.
4. **Troca de plano com cobrança proporcional.** Decidi não fazer pela metade:
   calcular errado a diferença de um plano para outro vira pedido de
   reembolso. Hoje trocar de plano encerra uma assinatura e começa outra.

---

## 5. Três decisões que eu tomei e o porquê

**O projeto não manda e-mail.** O carrinho abandonado dispara um aviso com o
link de recuperação pronto, e quem manda o e-mail é o cliente, com a ferramenta
que ele já usa. Motivo: se a gente mandasse, teríamos que cuidar de domínio de
envio, SPF, DKIM, reputação e devolução, dentro de um servidor que é de outra
pessoa. E o e-mail que de fato é aberto é o que vem do domínio do próprio
cliente. Você conhece esse problema de perto, pelo Resend.

**O tema não aceita CSS solto.** Cor tem que ser hexadecimal, fonte tem que
estar numa lista fechada, layout tem que ser uma das três palavras conhecidas.
É a mesma regra do construtor de aparência da Mitzshop, e pelo mesmo motivo:
num campo de cor que aceita qualquer texto dá para injetar CSS, e com CSS dá
para desenhar um formulário falso por cima do verdadeiro. Existe uma saída para
quem instala sozinho e assume o risco, desligada por padrão.

**A tela só oferece a forma de pagamento que funciona.** Se a empresa não
configurou gateway nenhum, a criação da sessão já falha, no servidor dela, onde
alguém lê a mensagem. O pior jeito de errar isso é deixar o comprador escolher
boleto, preencher tudo, e só então descobrir que não dá.

---

## 6. Onde fica cada coisa

```
opencheckout/
  src/
    config.js            Configuração, tudo vem do .env
    app.js               Monta o servidor
    server.js            Liga o servidor e os três laços de fundo
    db/
      index.js           Acesso ao banco, e a TRAVA de cliente
      merchant-context.js  De quem é esta requisição
      owned-tables.js    Quais tabelas têm dono
    lib/                 Dinheiro, validação, criptografia, erros
    gateways/
      contract.md        O contrato que todo gateway tem que cumprir
      demo.js            O gateway simulado, e o exemplo de como fazer um
    services/            A regra de negócio, um arquivo por assunto
    routes/
      api-v1.js          A API que o cliente usa
      hosted-checkout.js A tela de pagamento
      gateway-webhooks.js Onde o gateway avisa que pagou
      portal.js          O portal do comprador
  views/                 As telas (EJS)
  public/css/            O visual
  public/js/             O comportamento da tela
  db/schema.sql          O banco, 22 tabelas
  tests/                 150 testes
```

Os arquivos têm comentário explicando o **porquê** de cada decisão, não só o
que o código faz. É o mesmo estilo da Mitzshop.

---

## 7. Como rodar os testes

```bash
npm test
```

O código de saída vale: 0 quando passa, 1 quando falha. Se quiser conferir de
verdade, sem o pipe esconder a falha:

```bash
npm test > /dev/null 2>&1; echo "saiu com $?"
```

---

## 8. Trocar o nome do projeto

`OpenCheckout` é nome de trabalho. Para trocar, os lugares são poucos:

1. `package.json`, campo `name`
2. `README.md` e este guia
3. O prefixo `--oc-` no CSS (`public/css/checkout.css`)
4. O prefixo `oc-` nas classes das telas (`views/`)
5. Os cabeçalhos `OpenCheckout-Signature` e `OpenCheckout-Timestamp` em
   `src/services/webhooks-out.js`
6. `window.OpenCheckout` em `public/js/embed.js`

Se quiser, eu troco tudo de uma vez quando você escolher o nome. O que eu
sugiro é decidir isso antes de publicar, porque o cabeçalho da assinatura e o
nome no `window` entram no código dos clientes e depois doem para mudar.

---

## 9. Como publicar como open source

Hoje o projeto está numa pasta dentro do repositório da Mitzshop, o que foi de
propósito: assim dá para comparar os dois lado a lado enquanto ele cresce.

Quando quiser separar:

```bash
git subtree split --prefix=opencheckout -b opencheckout-only
```

Isso cria um ramo só com essa pasta e o histórico dela, pronto para empurrar
para um repositório novo no GitHub.

Antes de publicar, confira três coisas:

1. Nenhuma chave real no histórico. O `.gitignore` já cobre o `.env`.
2. O `LICENSE` está como MIT. MIT é a licença que empresa aceita usar sem
   consultar advogado, e é por isso que ela está aí.
3. O `README.md` é a primeira coisa que alguém lê. Ele já abre com os dois
   comandos que fazem a demo rodar, porque projeto que precisa de três chaves
   de API para o primeiro teste não ganha o primeiro teste.
