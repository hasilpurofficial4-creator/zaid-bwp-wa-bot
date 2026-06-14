# Modified Whatsapp-API
<p align='center'>
  <img src="https://fam-official.serv00.net/script12/fampng/Fambot.jpg" width="172">
</p>

--- 

## Usage
```json
"depencies": {
  "@famofc/baileys": "github:@famofc/baileys"
}
```
## Import
```javascript
const {
  default:makeWASocket,
  // Other Options 
} = require('@famofc/baileys');
```

---
# How To Connect To Whatsapp
## With QR Code
```javascript
const {
  default: makeWASocket
} = require('@famofc/baileys');

const client = makeWASocket({
  browser: ['Ubuntu', 'Chrome', '20.00.1'],
  printQRInTerminal: true
})
```

## Connect With Number
```javascript
const {
  default: makeWASocket,
  fetchLatestWAWebVersion
} = require('@famofc/baileys');

const client = makeWASocket({
  browser: ['Ubuntu', 'Chrome', '20.00.1'],
  printQRInTerminal: false,
  version: fetchLatestWAWebVersion()
  // Other options
});

const number = "628XXXXX";
const code = await client.requestPairingCode(number.trim) /* Use : (number, "YYYYYYYY") for custom-pairing */

console.log("Ur pairing code : " + code)
```

# Sending messages

## send orderMessage
```javascript
const fs = require('fs');
const ZeppImg = fs.readFileSync('./ZeppImage');

await client.sendMessage(m.chat, {
  thumbnail: ZeppImg,
  message: "Gotta get a grip",
  orderTitle: "famofc-Corporation",
  totalAmount1000: 72502,
  totalCurrencyCode: "IDR"
}, { quoted:m })
```

## send pollResultSnapshotMessage
```javascript
await client.sendMessage(m.chat, {
  pollResultMessage: {
    name: "famofc-Corporation",
    options: [
      {
        optionName: "poll 1"
      },
      {
        optionName: "poll 2"
      }
    ],
    newsletter: {
      newsletterName: "famofc | Killer Queen Information",
      newsletterJid: "1@newsletter"
    }
  }
})
```

## send productMessage
```javascript
await client.relayMessage(m.chat, {
  productMessage {
    title: "famofc.pdf",
    description: "zZZ...",
    thumbnail: { url: "./ZeppImage" },
    productId: "EXAMPLE_TOKEN",
    retailerId: "EXAMPLE_RETAILER_ID",
    url: "https://t.me/YuukeyDfamofc",
    body: "Nak Tido",
    footer: "Footer",
    buttons: [
      {
        name: "cta_url",
        buttonParamsJson: "{\"display_text\":\"famofc-Pdf\",\"url\":\"https://t.me/famofc\"}"
      }
    ],
    priceAmount1000: 72502,
    currencyCode: "IDR"
  }
})
```

## send member label
```javascript
await client.sendMessage(m.chat, {
  groupLabel: {
    labelText: "Tag anggota tercantum di sini"
  }
})
```

## send message to members in group
```javascript
await client.sendMessageMembers(m.chat, {
  extendedTextMessage: {
    text: "save aku famofc"
  }
}, {})
```
# Simple sendMessage

## send text
```javascript
await client.sendText(m.chat, "famofc", {
  contextInfo: {
    mentionedJid: [m.chat]
  }
}, {
  key: {
    remoteJid: "status@broadcast",
    participant: m.sender,
    fromMe: true
  },
  message: {
    conversation: "\0"
  }
})
```
## send image
```javascript
await client.sendImage(m.chat, { url: "./zepy.jpg" }, "famofc", {
  contextInfo: {
    mentionedJid: [m.chat]
  }
}, {
  key: {
    remoteJid: "status@broadcast",
    participant: m.sender,
    fromMe: true
  },
  message: {
    conversation: "\0"
  }
})
```

## send video
```javascript
await client.sendVideo(m.chat, { url: "./zepy.mp4" }, "famofc", {
  contextInfo: {
    mentionedJid: [m.chat]
  }
}, {
  key: {
    remoteJid: "status@broadcast",
    participant: m.sender,
    fromMe: true
  },
  message: {
    conversation: "\0"
  }
})
```

## send audio
```javascript
await client.sendAudio(m.chat, { url: "./zepy.mp3" }, {
  contextInfo: {
    mentionedJid: [m.chat]
  }
}, {
  key: {
    remoteJid: "status@broadcast",
    participant: m.sender,
    fromMe: true
  },
  message: {
    conversation: "\0"
  }
})
```

## send location
```javascript
await client.sendLocation(m.chat, "famofc", 90.0, 90.0, "https://t.me/XzC_Info", "1234567890", {
  contextInfo: {
    mentionedJid: [m.chat]
  }
}, {
  key: {
    remoteJid: "status@broadcast",
    participant: m.sender,
    fromMe: true
  },
  message: {
    conversation: "\0"
  }
})
```

## send polling
```javascript
await client.sendPoll(m.chat, "famofc", ["1", "2", "3"], true, {
  contextInfo: {
    mentionedJid: [m.chat]
  }
}, {
  key: {
    remoteJid: "status@broadcast",
    participant: m.sender,
    fromMe: true
  },
  message: {
    conversation: "\0"
  }
})
```

## send quiz
```javascript
await client.sendQuiz(m.chat, "famofc", ["1", "2", "3"], "2", {
  contextInfo: {
    mentionedJid: [m.chat]
  }
}, {
  key: {
    remoteJid: "status@broadcast",
    participant: m.sender,
    fromMe: true
  },
  message: {
    conversation: "\0"
  }
})
```

## send status mention
```javascript
await client.statusMention(m.chat, {
  extendedTextMessage: {
    text: "famofc"
  }
})
```
Follow https://t.me/XzC_Info kalau mau liat type message yg lain :v
