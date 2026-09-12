/**
 * im 聊天页 —— 唯一的页面，包含三块：
 *   1) 顶部状态栏（连接状态 + 重新配对入口）
 *   2) 消息列表（我发的气泡 / 机器人回复 / 主动关怀）
 *   3) 底部输入栏
 *
 * 首次使用走「连接 im 服务端」面板：**扫码登录**是主路径 ——
 * 服务器上跑 `npm run pair`，扫终端里的二维码即自动填好地址与 token。
 * 手填地址 + token 作为备选（服务端 token 在 .env 的 IM_APP_TOKEN）。
 *
 * 长轮询循环见 pollLoop()：拿到响应就更新 cursor 并立即再发，不 sleep ——
 * 服务端在无消息时会挂起至多 IM_LONG_POLL_TIMEOUT_MS，sleep 只会徒增延迟。
 */

import { common } from '@kit.AbilityKit';
import { promptAction } from '@kit.ArkUI';
import { AppConfig } from '../services/AppConfig';
import { ImClient, SendResp, SyncMsg, SyncResp, newClientMsgId } from '../services/ImClient';
import { PairPayload, PairResult, pairWithServer, parsePairPayload, scanOnce } from '../services/Pairing';
import { ChatMessage, MessageKind } from '../model/Message';

@Entry
@Component
struct Index {
  @State messages: ChatMessage[] = [];
  @State inputText: string = '';
  @State status: string = '';
  @State configured: boolean = false;
  @State cfgBaseUrl: string = '';
  @State cfgToken: string = '';
  @State pairing: boolean = false;
  @State pairMsg: string = '';
  private client: ImClient | null = null;
  private cursor: string = '';
  private running: boolean = false;
  private scroller: Scroller = new Scroller();

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    AppConfig.init(ctx);
    this.cfgBaseUrl = AppConfig.baseUrl();
    this.cfgToken = AppConfig.token();
    this.configured = AppConfig.isConfigured();
    if (this.configured) {
      this.startSession();
    } else {
      this.status = '尚未绑定服务端';
    }
  }

  aboutToDisappear(): void {
    this.running = false;
  }

  // ------------------------------------------------------------ 会话与轮询

  private startSession(): void {
    this.client = new ImClient(AppConfig.baseUrl(), AppConfig.token());
    // 冷启动恢复游标 → 补齐离线期间的消息
    this.cursor = AppConfig.cursor();
    this.running = true;
    this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    this.status = '连接中…';
    let failures = 0;
    while (this.running) {
      const client: ImClient | null = this.client;
      if (client === null) {
        return;
      }
      try {
        const resp: SyncResp = await client.sync(this.cursor);
        if (resp.cursor !== undefined && resp.cursor.length > 0) {
          this.cursor = resp.cursor;
          AppConfig.setCursor(resp.cursor);
        }
        const list: SyncMsg[] = resp.msgs;
        if (list !== undefined && list.length > 0) {
          for (const m of list) {
            this.onServerMessage(m);
          }
          this.scrollToBottom();
        }
        this.status = '已连接';
        failures = 0;
      } catch (e) {
        failures++;
        this.status = '连接断开，重试中…';
        await this.delay(failures >= 5 ? 30000 : 2000);
        if (failures >= 5) {
          failures = 0;
        }
      }
    }
  }

  private onServerMessage(m: SyncMsg): void {
    // 收到任意回复即认为此前的乐观消息已送达
    this.settleOldestPending();
    this.messages.push(new ChatMessage(m.serverMsgId, m.text, false, m.kind, m.ts));
  }

  private settleOldestPending(): void {
    for (let i = 0; i < this.messages.length; i++) {
      const msg: ChatMessage = this.messages[i];
      if (msg.fromMe && msg.pending) {
        msg.pending = false;
        this.messages.splice(i, 1, msg);
        return;
      }
    }
  }

  private markFailed(id: string): void {
    for (let i = 0; i < this.messages.length; i++) {
      const msg: ChatMessage = this.messages[i];
      if (msg.id === id) {
        msg.pending = false;
        msg.failed = true;
        this.messages.splice(i, 1, msg);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- 扫码登录

  private async onScanLogin(): Promise<void> {
    if (this.pairing) {
      return;
    }
    const ctx = getContext(this) as common.UIAbilityContext;
    this.pairing = true;
    this.pairMsg = '正在打开扫码…';

    const text: string | null = await scanOnce(ctx);
    if (text === null) {
      this.pairing = false;
      this.pairMsg = '已取消扫码';
      return;
    }

    const payload: PairPayload | null = parsePairPayload(text);
    if (payload === null) {
      this.pairing = false;
      this.pairMsg = '这不是 im 的配对二维码（应形如 im://pair?u=…&c=…）';
      return;
    }

    this.pairMsg = '正在与 ' + payload.publicUrl + ' 配对…';
    const res: PairResult = await pairWithServer(payload.publicUrl, payload.code);
    this.pairing = false;
    this.pairMsg = res.message;

    if (res.ok) {
      // 配对成功：地址与 token 已落盘，直接进聊天
      this.cfgBaseUrl = AppConfig.baseUrl();
      this.cfgToken = AppConfig.token();
      this.configured = true;
      this.startSession();
      this.toast('已绑定 ' + res.baseUrl);
    }
  }

  // ------------------------------------------------------------------ 发送

  private async onSend(): Promise<void> {
    const text: string = this.inputText.trim();
    if (text.length === 0) {
      return;
    }
    const client: ImClient | null = this.client;
    if (client === null) {
      this.toast('请先绑定服务端');
      return;
    }
    const id: string = newClientMsgId();
    this.inputText = '';
    this.messages.push(new ChatMessage(id, text, true, MessageKind.REPLY, Date.now(), true));
    this.scrollToBottom();
    try {
      const resp: SendResp = await client.send(text, id);
      if (resp.ret !== 0) {
        this.markFailed(id);
        this.toast('服务端拒绝：' + (resp.errmsg !== undefined ? resp.errmsg : '未知原因'));
      }
    } catch (e) {
      this.markFailed(id);
      this.toast('发送失败，请检查网络');
    }
  }

  private onSaveConfig(): void {
    const base: string = this.cfgBaseUrl.trim();
    const token: string = this.cfgToken.trim();
    if (base.length === 0 || token.length === 0) {
      this.toast('地址与 token 都不能为空');
      return;
    }
    AppConfig.setBaseUrl(base);
    AppConfig.setToken(token);
    this.configured = true;
    this.startSession();
  }

  /** 回到绑定面板（重新配对 / 换服务器） */
  private onRebind(): void {
    this.running = false;
    this.client = null;
    this.pairMsg = '';
    this.configured = false;
    this.status = '尚未绑定服务端';
  }

  // ------------------------------------------------------------------ 工具

  private scrollToBottom(): void {
    this.scroller.scrollEdge(Edge.Bottom);
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve: (value: void) => void) => {
      setTimeout(() => {
        resolve();
      }, ms);
    });
  }

  private toast(text: string): void {
    promptAction.showToast({ message: text, duration: 2000 });
  }

  private bubbleColor(m: ChatMessage): Resource {
    if (m.fromMe) {
      return $r('app.color.bubble_me');
    }
    if (m.isProactive()) {
      return $r('app.color.bubble_proactive');
    }
    return $r('app.color.bubble_other');
  }

  private textColor(m: ChatMessage): Resource {
    return m.fromMe ? $r('app.color.text_on_me') : $r('app.color.text_primary');
  }

  // -------------------------------------------------------------------- UI

  @Builder
  messageBubble(m: ChatMessage) {
    Row() {
      if (m.fromMe) {
        Blank()
      }
      Column() {
        if (m.isProactive()) {
          Text('主动关心')
            .fontSize(10)
            .fontColor($r('app.color.text_secondary'))
            .margin({ bottom: 4 })
        }
        Text(m.text)
          .fontSize(15)
          .fontColor(this.textColor(m))
        if (m.pending) {
          Text('发送中…')
            .fontSize(10)
            .fontColor($r('app.color.text_secondary'))
            .margin({ top: 4 })
        } else if (m.failed) {
          Text('发送失败')
            .fontSize(10)
            .fontColor(Color.Red)
            .margin({ top: 4 })
        }
      }
      .alignItems(HorizontalAlign.Start)
      .padding(10)
      .borderRadius(10)
      .backgroundColor(this.bubbleColor(m))
      .constraintSize({ maxWidth: '74%' })
      if (!m.fromMe) {
        Blank()
      }
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 6, bottom: 6 })
  }

  @Builder
  setupPanel() {
    Column() {
      Text('绑定 im 服务端')
        .fontSize(20)
        .fontWeight(FontWeight.Bold)
        .margin({ bottom: 8 })

      Text('在服务器上运行 npm run pair，终端会出现二维码')
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .textAlign(TextAlign.Center)
        .margin({ bottom: 16 })

      Button(this.pairing ? '扫码中…' : '扫码登录')
        .width('100%')
        .height(44)
        .enabled(!this.pairing)
        .onClick(() => {
          this.onScanLogin();
        })

      if (this.pairMsg.length > 0) {
        Text(this.pairMsg)
          .fontSize(12)
          .fontColor($r('app.color.text_secondary'))
          .textAlign(TextAlign.Center)
          .margin({ top: 10, bottom: 4 })
      }

      Divider()
        .margin({ top: 20, bottom: 16 })

      Text('或手动填写')
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .margin({ bottom: 10 })

      TextInput({ text: this.cfgBaseUrl, placeholder: 'https://im.example.com' })
        .type(InputType.Normal)
        .onChange((v: string) => {
          this.cfgBaseUrl = v;
        })
        .margin({ bottom: 10 })

      TextInput({ text: this.cfgToken, placeholder: 'IM_APP_TOKEN' })
        .type(InputType.Password)
        .onChange((v: string) => {
          this.cfgToken = v;
        })
        .margin({ bottom: 14 })

      Button('保存并连接')
        .width('100%')
        .backgroundColor('#8A8A8A')
        .onClick(() => {
          this.onSaveConfig();
        })
    }
    .width('100%')
    .height('100%')
    .padding(24)
    .justifyContent(FlexAlign.Center)
    .backgroundColor(Color.White)
  }

  @Builder
  chatPanel() {
    Column() {
      Row() {
        Text('im')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
        Blank()
        Text(this.status)
          .fontSize(12)
          .fontColor($r('app.color.text_secondary'))
        Text('重新配对')
          .fontSize(12)
          .fontColor('#1AAD19')
          .margin({ left: 12 })
          .onClick(() => {
            this.onRebind();
          })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 12 })
      .backgroundColor(Color.White)

      List({ scroller: this.scroller }) {
        ForEach(this.messages, (m: ChatMessage) => {
          ListItem() {
            this.messageBubble(m)
          }
        }, (m: ChatMessage) => m.id)
      }
      .layoutWeight(1)
      .width('100%')
      .backgroundColor($r('app.color.chat_bg'))

      Row() {
        TextInput({ text: this.inputText, placeholder: $r('app.string.input_placeholder') })
          .layoutWeight(1)
          .onChange((v: string) => {
            this.inputText = v;
          })
          .onSubmit(() => {
            this.onSend();
          })
        Button($r('app.string.send'))
          .margin({ left: 8 })
          .onClick(() => {
            this.onSend();
          })
      }
      .width('100%')
      .padding(12)
      .backgroundColor(Color.White)
    }
    .width('100%')
    .height('100%')
  }

  build() {
    Column() {
      if (this.configured) {
        this.chatPanel()
      } else {
        this.setupPanel()
      }
    }
    .width('100%')
    .height('100%')
  }
}
