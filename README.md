# Folia-LX：加上了 LX Music 接口的 Folia

这是音乐播放器 [Folia](https://github.com/chthollyphile/folia-major) 0.7.25 的一个改版，**只多了一样东西：LX Music（洛雪音乐）音乐接口**。其余功能、界面都和原版一模一样。

装好以后，Folia 里会多出一个 **LX Music** 平台，和网易云、QQ 音乐这些平台用法一样：

- 🔍 搜歌：同时搜酷我、网易云、QQ 音乐等平台
- 🎵 播放：用你在 LX Music 里导入的自定义源播放，支持无损音质
- 📝 歌词：滚动歌词、播放动画都和其他平台一样
- 📂 歌单：直接显示你在 LX Music 里的歌单（试听列表、我的收藏，以及你导入的歌单）
- 🙅 不用登录任何账号

> 原版 Folia 的介绍在 [README.folia.md](README.folia.md)。

---

## 一、你需要准备什么

开始之前，确认下面三样都有：

| 需要 | 怎么确认 |
| --- | --- |
| **一台苹果芯片的 Mac**（M1、M2、M3、M4 …） | 点屏幕左上角 苹果图标 → “关于本机”，“芯片”一行写着 Apple M 开头就可以。写着 Intel 的不能用。 |
| **LX Music 桌面版** | 没有的话去 [LX Music 官网](https://github.com/lyswhut/lx-music-desktop/releases) 下载 Mac 版装好。 |
| **LX Music 里导入了一个“自定义源”** | 打开 LX Music → 设置 → 自定义源，里面至少有一个源，并且在 LX Music 里能正常放歌。没有源的话 Folia 也放不了歌。 |

---

## 二、安装（一步一步来）

### 第 1 步：下载

1. 打开本仓库右边的 **Releases**（或者点这里：[Releases 页面](../../releases)）。
2. 在最新版本下面找到 **Folia.zip**，点一下下载。文件有两三百 MB，耐心等它下完。

### 第 2 步：放进“应用程序”

1. 打开“下载”文件夹，双击 **Folia.zip**，会解压出一个 **Folia**。
2. 打开“访达”，点左边的 **应用程序**。
3. 把 **Folia** 拖进“应用程序”里。
   - 如果电脑上以前装过 Folia，会问你要不要替换：先退出正在运行的 Folia，再点 **替换**。

### 第 3 步：解除 macOS 的拦截（只需要做一次）

这个版本没有经过苹果公证，第一次打开时 macOS 可能会说 **“Folia 已损坏，无法打开”**。这不是真的坏了，按下面做就好：

1. 按 `⌘ 空格`，输入 **终端**，回车打开“终端”。
2. 把下面这一行 **完整复制**，粘贴到终端里，按回车：

   ```bash
   xattr -cr /Applications/Folia.app
   ```

3. 没有任何提示就说明成功了，可以关掉终端。

### 第 4 步：打开 Folia

在“应用程序”里双击 **Folia**，能正常打开就装好了 🎉

---

## 三、怎么用

1. 打开 Folia，找到切换音乐平台的地方，选 **LX Music**（图标是绿色的“洛”字）。
2. 点 **登录**，会显示“连接这台电脑上的 LX Music”，点 **连接**。不需要账号和密码。
3. 连上以后：
   - 在搜索框里搜歌，点一首就能播放；
   - 在歌单里能看到你在 LX Music 里的歌单。

小提示：

- **LX Music 不用开着**，但不能卸载。Folia 会直接读取 LX Music 里的音源和歌单。
- **想换音源？** 去 LX Music 里换，Folia 会自动跟着用新的。
- **音质**：在 Folia 的设置里选音质，最高支持无损（要看你的音源支不支持）。

---

## 四、常见问题

**打开 Folia 提示“已损坏”或“无法验证开发者”**
再做一次上面的第 3 步。还不行的话：打开“系统设置” → “隐私与安全性”，往下翻，看到 Folia 的提示时点 **仍要打开**。

**连接时一直连不上 / 提示找不到 LX Music**
确认 LX Music 装在电脑上并且至少打开过一次，然后在 LX Music 的设置里导入了自定义源。

**搜得到歌但放不了**
一般是音源的问题：换一个自定义源试试，或者先在 LX Music 里确认同一首歌能放。Folia 放不了的歌，会自动去其他平台找同一首来放。

**有的歌没有歌词**
酷我的部分歌曲拿不到歌词，Folia 会自动去别的地方匹配歌词。网易云、QQ 音乐的歌一般都有歌词。

**更新 Folia 之后 LX Music 不见了**
官方新版本里没有这个接口。想继续用，就别从官网更新，或者等本仓库出新版本。

**想换回原版 Folia**
去 [Folia 官方 Releases](https://github.com/chthollyphile/folia-major/releases) 下载原版，按同样的方法拖进“应用程序”替换即可。

---

## 五、源代码与开源协议

- 本仓库基于 [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major) **v0.7.25**，遵循原项目的 **AGPL-3.0** 协议（见 [LICENSE](LICENSE)）。Folia 的所有功劳归原作者和贡献者。
- 仓库里有两次提交：第一次是原版 0.7.25 的源代码，第二次是 **“加入 LX Music 音乐接口”**，点开那次提交就能看到改了哪些地方。
- 新增的代码主要在：
  - `electron/lxmusic/`：在电脑上读取 LX Music 的音源和歌单、运行自定义源、搜歌和取歌词
  - `src/services/onlineMusic/lxmusic/`：Folia 里的 LX Music 平台
- LX Music 是 [lyswhut/lx-music-desktop](https://github.com/lyswhut/lx-music-desktop)，本项目只读取它的数据，不修改 LX Music 的任何文件。
- 本项目仅供学习交流。播放的歌曲来自你自己导入的音源，请支持正版音乐。
