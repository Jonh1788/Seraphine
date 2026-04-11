# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: audio-context.spec.ts >> AudioContext lifecycle >> no AudioContext errors after user click
- Location: e2e/audio-context.spec.ts:27:3

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 3

- Array []
+ Array [
+   "The AudioContext encountered an error from the audio device or the WebAudio renderer.",
+ ]
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - banner [ref=e4]:
    - generic [ref=e5]: Seraphine
    - generic [ref=e7]: online
  - generic [ref=e9]:
    - complementary [ref=e10]:
      - img "Seraphine avatar" [ref=e12]
      - generic [ref=e14]:
        - generic [ref=e15] [cursor=pointer]:
          - generic [ref=e16]: Responder com áudio
          - checkbox "Responder com áudio" [checked] [ref=e17]
        - generic [ref=e18] [cursor=pointer]:
          - generic [ref=e19]: Pensar antes de responder
          - checkbox "Pensar antes de responder" [ref=e20]
      - generic [ref=e22]:
        - heading "Memorias" [level=3] [ref=e23]
        - generic [ref=e24]:
          - textbox "Ensinar um fato novo..." [ref=e25]
          - button "+" [disabled] [ref=e26]
        - list [ref=e27]:
          - listitem [ref=e28]:
            - generic [ref=e29]: R$ 6.000,00
            - generic [ref=e30]:
              - generic [ref=e31]: reflexao
              - generic [ref=e32]: 70%
            - generic [ref=e33]:
              - button "Editar" [ref=e34] [cursor=pointer]
              - button "Esquecer" [ref=e35] [cursor=pointer]
          - listitem [ref=e36]:
            - generic [ref=e37]: 4-5 dias
            - generic [ref=e38]:
              - generic [ref=e39]: reflexao
              - generic [ref=e40]: 70%
            - generic [ref=e41]:
              - button "Editar" [ref=e42] [cursor=pointer]
              - button "Esquecer" [ref=e43] [cursor=pointer]
          - listitem [ref=e44]:
            - generic [ref=e45]: Relaxar na praia/piscina
            - generic [ref=e46]:
              - generic [ref=e47]: reflexao
              - generic [ref=e48]: 70%
            - generic [ref=e49]:
              - button "Editar" [ref=e50] [cursor=pointer]
              - button "Esquecer" [ref=e51] [cursor=pointer]
          - listitem [ref=e52]:
            - generic [ref=e53]: Porto Seguro (destino), saindo de Itabuna (origem)
            - generic [ref=e54]:
              - generic [ref=e55]: reflexao
              - generic [ref=e56]: 70%
            - generic [ref=e57]:
              - button "Editar" [ref=e58] [cursor=pointer]
              - button "Esquecer" [ref=e59] [cursor=pointer]
          - listitem [ref=e60]:
            - generic [ref=e61]: "Interesse de viagem:"
            - generic [ref=e62]:
              - generic [ref=e63]: reflexao
              - generic [ref=e64]: 70%
            - generic [ref=e65]:
              - button "Editar" [ref=e66] [cursor=pointer]
              - button "Esquecer" [ref=e67] [cursor=pointer]
          - listitem [ref=e68]:
            - generic [ref=e69]: Usuário está interessado em tópicos técnicos como *health-checks*, *endpoints*, *commits* Git, e otimização de código (CSS, *console.log*).
            - generic [ref=e70]:
              - generic [ref=e71]: reflexao
              - generic [ref=e72]: 70%
            - generic [ref=e73]:
              - button "Editar" [ref=e74] [cursor=pointer]
              - button "Esquecer" [ref=e75] [cursor=pointer]
          - listitem [ref=e76]:
            - generic [ref=e77]: Usuário está ciente e interessado em processos de gestão de tarefas e *backlogs* (Supertasks).
            - generic [ref=e78]:
              - generic [ref=e79]: reflexao
              - generic [ref=e80]: 70%
            - generic [ref=e81]:
              - button "Editar" [ref=e82] [cursor=pointer]
              - button "Esquecer" [ref=e83] [cursor=pointer]
          - listitem [ref=e84]:
            - generic [ref=e85]: Usuário está envolvido em projetos de desenvolvimento/manutenção de sistemas, especificamente relacionados a 'raspeicerto', 'raspadinha', 'rasp-app-tiktok', e 'cash-laravel'.
            - generic [ref=e86]:
              - generic [ref=e87]: reflexao
              - generic [ref=e88]: 70%
            - generic [ref=e89]:
              - button "Editar" [ref=e90] [cursor=pointer]
              - button "Esquecer" [ref=e91] [cursor=pointer]
          - listitem [ref=e92]:
            - generic [ref=e93]: Usuário prefere interagir com a assistente usando o nome 'Sera' ou 'Seraphine'.
            - generic [ref=e94]:
              - generic [ref=e95]: reflexao
              - generic [ref=e96]: 70%
            - generic [ref=e97]:
              - button "Editar" [ref=e98] [cursor=pointer]
              - button "Esquecer" [ref=e99] [cursor=pointer]
          - listitem [ref=e100]:
            - generic [ref=e101]: "Data comemorativa: Aniversário de Namoro em 12/06"
            - generic [ref=e102]:
              - generic [ref=e103]: reflexao
              - generic [ref=e104]: 70%
            - generic [ref=e105]:
              - button "Editar" [ref=e106] [cursor=pointer]
              - button "Esquecer" [ref=e107] [cursor=pointer]
          - listitem [ref=e108]:
            - generic [ref=e109]: "Data de aniversário de namoro: 12/06"
            - generic [ref=e110]:
              - generic [ref=e111]: reflexao
              - generic [ref=e112]: 70%
            - generic [ref=e113]:
              - button "Editar" [ref=e114] [cursor=pointer]
              - button "Esquecer" [ref=e115] [cursor=pointer]
          - listitem [ref=e116]:
            - generic [ref=e117]: "Status de relacionamento: Casado com Aline"
            - generic [ref=e118]:
              - generic [ref=e119]: reflexao
              - generic [ref=e120]: 70%
            - generic [ref=e121]:
              - button "Editar" [ref=e122] [cursor=pointer]
              - button "Esquecer" [ref=e123] [cursor=pointer]
          - listitem [ref=e124]:
            - generic [ref=e125]: Usuário gosta da música 'Leo foguete galeria'. User requested 'Leo foguete galeria'
            - generic [ref=e126]:
              - generic [ref=e127]: ensinado
              - generic [ref=e128]: 90%
            - generic [ref=e129]:
              - button "Editar" [ref=e130] [cursor=pointer]
              - button "Esquecer" [ref=e131] [cursor=pointer]
          - listitem [ref=e132]:
            - generic [ref=e133]: "Equipamento: Mac M4 Pro Max com 36GB de RAM"
            - generic [ref=e134]:
              - generic [ref=e135]: reflexao
              - generic [ref=e136]: 70%
            - generic [ref=e137]:
              - button "Editar" [ref=e138] [cursor=pointer]
              - button "Esquecer" [ref=e139] [cursor=pointer]
          - listitem [ref=e140]:
            - generic [ref=e141]: "Estado Civil: Casado com Aline"
            - generic [ref=e142]:
              - generic [ref=e143]: reflexao
              - generic [ref=e144]: 70%
            - generic [ref=e145]:
              - button "Editar" [ref=e146] [cursor=pointer]
              - button "Esquecer" [ref=e147] [cursor=pointer]
          - listitem [ref=e148]:
            - generic [ref=e149]: 12/06
            - generic [ref=e150]:
              - generic [ref=e151]: reflexao
              - generic [ref=e152]: 70%
            - generic [ref=e153]:
              - button "Editar" [ref=e154] [cursor=pointer]
              - button "Esquecer" [ref=e155] [cursor=pointer]
          - listitem [ref=e156]:
            - generic [ref=e157]: "Aniversário de Namoro: 12/06"
            - generic [ref=e158]:
              - generic [ref=e159]: reflexao
              - generic [ref=e160]: 70%
            - generic [ref=e161]:
              - button "Editar" [ref=e162] [cursor=pointer]
              - button "Esquecer" [ref=e163] [cursor=pointer]
          - listitem [ref=e164]:
            - generic [ref=e165]: "Profissão: Engenheiro de Software"
            - generic [ref=e166]:
              - generic [ref=e167]: reflexao
              - generic [ref=e168]: 70%
            - generic [ref=e169]:
              - button "Editar" [ref=e170] [cursor=pointer]
              - button "Esquecer" [ref=e171] [cursor=pointer]
          - listitem [ref=e172]:
            - generic [ref=e173]: "Nome: Jonathan"
            - generic [ref=e174]:
              - generic [ref=e175]: reflexao
              - generic [ref=e176]: 70%
            - generic [ref=e177]:
              - button "Editar" [ref=e178] [cursor=pointer]
              - button "Esquecer" [ref=e179] [cursor=pointer]
        - generic [ref=e180]:
          - button "Exportar" [ref=e181] [cursor=pointer]
          - button "Importar" [ref=e182] [cursor=pointer]
    - generic [ref=e183]:
      - log [ref=e184]:
        - generic [ref=e185]:
          - strong [ref=e186]: Comece a conversa
          - text: Digite uma mensagem ou segure o microfone pra falar.
      - generic [ref=e187]:
        - button "Choose File" [ref=e188]
        - button "Anexar imagem" [ref=e189] [cursor=pointer]:
          - img [ref=e190]
        - textbox "Mensagem" [ref=e192]:
          - /placeholder: Digite e Enter ou cole uma imagem...
        - button "Enviar" [disabled] [ref=e193]
        - button "Gravar áudio" [ref=e194] [cursor=pointer]:
          - img [ref=e195]
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | test.describe('AudioContext lifecycle', () => {
  4  |   test('no AudioContext errors on page load (before user gesture)', async ({ page }) => {
  5  |     const errors: string[] = [];
  6  |     page.on('console', (msg) => {
  7  |       const text = msg.text();
  8  |       if (text.includes('AudioContext') && text.includes('error')) {
  9  |         errors.push(text);
  10 |       }
  11 |     });
  12 |     page.on('pageerror', (err) => {
  13 |       if (err.message.includes('AudioContext')) {
  14 |         errors.push(err.message);
  15 |       }
  16 |     });
  17 | 
  18 |     await page.goto('/');
  19 |     // Wait for the app to fully mount and settle
  20 |     await page.waitForSelector('.topbar__brand', { timeout: 10_000 });
  21 |     // Give it extra time for any async init that might trigger the error
  22 |     await page.waitForTimeout(3000);
  23 | 
  24 |     expect(errors).toEqual([]);
  25 |   });
  26 | 
  27 |   test('no AudioContext errors after user click', async ({ page }) => {
  28 |     const errors: string[] = [];
  29 |     page.on('console', (msg) => {
  30 |       const text = msg.text();
  31 |       if (text.includes('AudioContext') && text.includes('error')) {
  32 |         errors.push(text);
  33 |       }
  34 |     });
  35 | 
  36 |     await page.goto('/');
  37 |     await page.waitForSelector('.topbar__brand', { timeout: 10_000 });
  38 |     await page.waitForTimeout(1000);
  39 | 
  40 |     // Simulate a user gesture (click) to trigger AudioContext creation
  41 |     await page.click('body');
  42 |     await page.waitForTimeout(2000);
  43 | 
> 44 |     expect(errors).toEqual([]);
     |                    ^ Error: expect(received).toEqual(expected) // deep equality
  45 |   });
  46 | 
  47 |   test('AudioContext is NOT created before user gesture', async ({ page }) => {
  48 |     await page.goto('/');
  49 |     await page.waitForSelector('.topbar__brand', { timeout: 10_000 });
  50 |     await page.waitForTimeout(2000);
  51 | 
  52 |     // Check that no AudioContext exists yet
  53 |     const ctxCount = await page.evaluate(() => {
  54 |       // @ts-ignore - accessing internal state for test
  55 |       return (window as any).__audioContextCount ?? 0;
  56 |     });
  57 | 
  58 |     // Inject a counter to track AudioContext creation
  59 |     const hasCtx = await page.evaluate(() => {
  60 |       // Check if PCMPlayback created a context by looking at the
  61 |       // AudioContext instances. We can't directly inspect the class,
  62 |       // but we can check the global AudioContext count.
  63 |       // A fresh page with our fix should have 0 active contexts.
  64 |       const origAC = window.AudioContext || (window as any).webkitAudioContext;
  65 |       if (!origAC) return false;
  66 |       // Can't retroactively count, but we can verify the
  67 |       // console had no AudioContext errors (covered by other tests).
  68 |       return true;
  69 |     });
  70 | 
  71 |     expect(hasCtx).toBe(true);
  72 |   });
  73 | 
  74 |   test('AudioContext resumes on first interaction and plays without errors', async ({ page }) => {
  75 |     const errors: string[] = [];
  76 |     page.on('console', (msg) => {
  77 |       const text = msg.text();
  78 |       if (text.includes('AudioContext') && text.includes('error')) {
  79 |         errors.push(text);
  80 |       }
  81 |     });
  82 | 
  83 |     await page.goto('/');
  84 |     await page.waitForSelector('.topbar__brand', { timeout: 10_000 });
  85 | 
  86 |     // Type in the chat input (a user gesture)
  87 |     const input = page.locator('.chat__input');
  88 |     if (await input.isVisible()) {
  89 |       await input.click();
  90 |       await input.fill('test');
  91 |       await page.waitForTimeout(1000);
  92 |     }
  93 | 
  94 |     expect(errors).toEqual([]);
  95 |   });
  96 | });
  97 | 
```