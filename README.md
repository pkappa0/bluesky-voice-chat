# 音声対話室

Mac上で使う日本語の対話アプリです。入力をOpenAI APIで処理し、応答を既存のZEN-TTS v1.4.0で音声にします。ChromeのWebGPUで合成し、Web Audioで再生します。起動後の利用にCodexやWorkは不要です。

## 使い方

Finderでこのフォルダを開き、ターミナルで下記を実行してください。このMacのmiseとNode.js 26.12.1を使います。pnpmでのインストールは不要です。既存のPythonデモとは別のポートを使います。

1. **音声だけ試す**
   `./start.command` を実行し、Mac版Chromeで [http://127.0.0.1:8765](http://127.0.0.1:8765) を開きます。「声を試す」で全力マリンの声を再生します。初回はZEN-TTS公式CDNから音声モデルを取得します。
2. **文字で会話する**
   ターミナルで Control+C を押し、`./start.command --api` で起動し直します。表示されない入力欄にOpenAI APIキーを貼り付け、Enterを押します。Chromeでページを再読み込みし、メッセージを入力して「送信」を押します。
3. **マイクで会話する**
   「録音する」を押してChromeにマイクを許可し、短く話して「録音を止めて送信」を押します。最長30秒で自動送信します。認識された発言と返答を画面に表示し、返答を読み上げます。認識できない場合は短く話し直すか、テキスト入力を使ってください。

4. **リアルタイムで会話する**
   「リアルタイム会話を開始」を押し、「聞いています」と表示されたら話します。「相づち」では、話している間にZEN-TTSで短い相づちを返します。「いまの質問に回答」を押すと答えます。話している途中で押すと、発話の終了を検出してから答えます。「自動回答」を選ぶと、発話の終了ごとに答えます。回答を生成・再生している間はマイク入力を一時停止し、再生後に再開します。停止するには「リアルタイム会話を終了」を押してください。接続中の発話はWebRTCでOpenAIへ送信されます。既定のRealtimeモデルは `gpt-realtime-2.1` で、`OPENAI_REALTIME_MODEL` で変更できます。[Realtime APIのWebRTCガイド](https://developers.openai.com/api/docs/guides/realtime-webrtc)

起動場所を指定したい場合は `ZEN_TTS_DIR` にZEN-TTSのフォルダを、8765番が使用中なら `PORT` に空いているポートを指定します。ChromeのWebGPUと、マイクを使う場合はChromeおよびmacOSのマイク許可が必要です。

## テキスト読み上げ

「読み上げるテキスト」に文章を入力し、「読み上げる」を押すと選択中の声で再生します。「週刊ブルースカイニュース！」を押すと、同じ声でそのフレーズを明るく、少しゆっくり再生します。どちらも音声合成はMac上で行われ、OpenAI APIキーなしで利用できます。リアルタイム会話中に使うときは、会話を終了してから再生してください。

## 口調と性格

画面の「口調・性格の設定」で、各200文字まで指定できます。設定はこのブラウザに保存され、会話の指示としてOpenAIに送信されます。空欄にすると既定のスタイルに戻ります。リアルタイム会話中に変更した場合は、一度終了して開始し直すと反映されます。

## データとAPIキー

キーはローカルサーバーの環境変数として保持します。アプリはキーをファイル、ブラウザ、ログに出力しません。起動コマンドの引数やソースにキーを書かず、起動時の非表示入力を使ってください。サーバーは `127.0.0.1` でのみ待ち受けます。

録音停止時の音声は文字起こしに送信し、テキストと直近4往復は返答生成に送信します。いずれもOpenAI APIに送信されるため、API利用には別途料金が発生する場合があります。アプリは音声や会話をディスクに保存せず、会話表示は再読み込みで消えます。返答の音声合成はMac上で行います。

既定のAPIモデルは音声認識が `gpt-4o-mini-transcribe`、返答生成が `gpt-4.1-mini` です。必要に応じて `OPENAI_STT_MODEL` と `OPENAI_CHAT_MODEL` で、対応するAPIモデルを指定できます。[音声認識API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create) · [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini)

## Blueskyちゃんを使う場合

手元の `~/zen-tts/voices/bluesky.ztm` は配布版1.1.1とSHA-256が一致しています。モデル配布元は、ソースコードを一般公開し、OSI承認ライセンスで配布するプロジェクトに利用を限定しています。このアプリのソースにはMITライセンスを添付しています。モデルの利用条件を満たした段階で、`BLUESKY_LICENSE_OK=1 ./start.command`（対話する場合は末尾に `--api` を追加）で起動すると、手元のファイルを読み込みます。現状のローカル版では全力マリンが既定です。[モデルの利用条件](https://github.com/kojira/zen-tts-models/blob/main/LICENSE.md) · [1.1.1の配布ページ](https://github.com/kojira/zen-tts-models/releases/tag/bluesky-v1.1.1)

## クレジット

- 音声合成：ZEN-TTS（[https://zenryokukikai.com](https://zenryokukikai.com)）
- 音声モデル：Blueskyちゃん（[https://github.com/kojira/zen-tts-models](https://github.com/kojira/zen-tts-models)）／ ZEN-TTS（[https://zenryokukikai.com](https://zenryokukikai.com)）
- 本アプリのソースに付属するMITライセンスはZEN-TTSおよび追加音声モデルには適用されません。ZEN-TTSのライセンスと第三者の通知はアプリ画面から参照できます。既存のエンジンと重みは変更せず参照し、このフォルダに同梱していません。[ZEN-TTSライセンス](https://github.com/zenryokukikai/zen-tts/blob/main/LICENSE.md)
