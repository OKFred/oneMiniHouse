import { Buffer } from "buffer"; //Node v16 需要引入

let main = (() => {
    let tcp = {
        address: "",
        port: "",
        connected: false,
        socket: null,
        query: "",
        dataReader: null,
    };

    function setData(obj) {
        if (obj) Object.assign(tcp, obj);
        return tcp;
    }

    function toggleConnect() {
        let { address, port } = tcp;
        console.log("连接目标服务器", address, port);
        if (tcp.connected) return console.log("已连接，无需重复连接");
        if (!tcp.query) {
            return console.log("请先设置问询数据");
        }
        onTCPConnect({ address, port });
    } //连接服务器

    async function onTCPConnect({ address, port }) {
        console.log("进行tcp连接");
        if (!uni.createTCPSocket) return console.log("⚠️当前环境不支持TCP连接");
        tcp.socket = uni.createTCPSocket();
        if (!tcp.socket) return console.log("socket创建失败");
        tcp.socket.connect({ address, port });
        tcp.socket.onConnect((e) => {
            console.log(new Date().toLocaleTimeString() + "已连接");
            tcp.connected = true;
            tcp.starter?.();
        });
        tcp.socket.onClose((e) => {
            console.log(new Date().toLocaleTimeString() + "已断开");
            tcp.connected = false;
            tcp.saver?.();
        });
        tcp.socket.onMessage((e) => {
            console.log("收到数据", e);
            let { message, remoteInfo, localInfo, size } = e;
            let finalData = buf2hex(message);
            // console.log(finalData, finalData);
            tcp.dataReader?.(finalData);
        }); //接收数据
    }

    function sendMessage(hex) {
        if (!tcp.connected) return console.log("未连接");
        let hexArr = [];
        for (let i = 0; i < hex.length; i = i + 2) {
            hexArr.push("0x" + hex.substring(i, i + 2));
        }
        let buffer = Buffer.from(hexArr); //将数组放到buffer
        tcp.socket.write(buffer);
        return true;
    } //发送数据

    function buf2hex(buffer) {
        // buffer is an ArrayBuffer
        return [...new Uint8Array(buffer)].map((x) => x.toString(16).padStart(2, "0")).join("");
    }

    return { setData, toggleConnect, sendMessage };
})();

export default main;
