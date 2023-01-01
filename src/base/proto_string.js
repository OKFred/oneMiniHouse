String.prototype.firstUpperCase = function () {
  const arr = this.split(" ");
  const upperWords = [];
  arr.forEach((str) => {
      upperWords.push(str.charAt(0).toUpperCase() + str.slice(1));
  });
  const result = upperWords.join(" ");
  return result;
}; /* 单词首字母大写 */

String.prototype.dataURItoBlob = function () {
  const dataURI = this.toString();
  // convert base64 to raw binary data held in a string
  // doesn't handle URLEncoded DataURIs - see SO answer #6850276 for code that does this
  const byteString = atob(dataURI.split(",")[1]);

  // separate out the mime component
  const mimeString = dataURI.split(",")[0].split(":")[1].split(";")[0];

  // write the bytes of the string to an ArrayBuffer
  const ab = new ArrayBuffer(byteString.length);

  // create a view into the buffer
  const ia = new Uint8Array(ab);

  // set the bytes of the buffer to the correct values
  for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
  }

  // write the ArrayBuffer to a blob, and you're done
  const blob = new Blob([ab], { type: mimeString });
  return blob;
};

String.prototype.validateEmail = function () {
  const email = this.toString();
  const re =
      /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  return re.test(String(email).toLowerCase());
}; /* 邮箱地址验证 */

String.prototype.encodeNonASCII = function () {
  const arr = [...this];
  for (let i = 0; i < arr.length; i++) {
      if (arr[i].charCodeAt() > 255) arr[i] = encodeURI(arr[i]);
  }
  return arr.join("");
};

String.prototype.decodeHTMLEntity = function () {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = this;
  const value = textarea.value;
  textarea.remove();
  return value;
};

String.prototype.encodeHTMLEntity = function () {
  var div = document.createElement("div");
  div.appendChild(document.createTextNode(this));
  return div.innerHTML;
};

String.prototype.hexToDec = function hexToDec() {
  let hex = this;
  let str = parseInt("0x" + hex).toString();
  let num = Number(str);
  if (isNaN(num)) return 0;
  return num;
}; //16进制 → 10进制

String.prototype.hexToFloat = function hexToFloat() {
  let hex = this;
  let float = 0; //小数
  let sign; //正负
  let mantissa; //有效位
  let exp; //指数
  let dec = 0; //十进制
  let multi = 1;
  let result; //返回值
  if (/^0x/.exec(hex)) {
      dec = parseInt(hex, 16);
  } else {
      for (let i = hex.length - 1; i >= 0; i -= 1) {
          if (hex.charCodeAt(i) > 255) return console.log("Wrong string--非16进制");
          dec += hex.charCodeAt(i) * multi;
          multi *= 256;
      }
  }
  sign = dec >>> 31 ? -1 : 1;
  exp = ((dec >>> 23) & 0xff) - 127;
  mantissa = ((dec & 0x7fffff) + 0x800000).toString(2);
  for (let i = 0; i < mantissa.length; i += 1) {
      float += parseInt(mantissa[i]) ? Math.pow(2, exp) : 0;
      exp--;
  }
  result = float * sign;
  return result;
}; //16进制转换为小数
