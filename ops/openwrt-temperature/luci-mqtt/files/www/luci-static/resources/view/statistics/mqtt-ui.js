'use strict';
'require view';
'require form';

return view.extend({
	render: function() {
		var m = new form.Map('collectd_mqtt_ui', 'MQTT 上报',
			'将 collectd 已启用的指标发送到 MQTT。安装后默认关闭；填写账号并完成主题授权后再启用。' +
			'温度传感器及采集间隔请在“统计 → 设置”中配置。');
		var s = m.section(form.NamedSection, 'main', 'mqtt');
		s.addremove = false;
		var o = s.option(form.Flag, 'enabled', '启用上报');
		o.rmempty = false;
		o.default = '0';
		var enabled = o;
		function required(section, value) {
			return !!value || enabled.formvalue(section) !== '1' || '启用上报前请填写此项';
		}

		function text(name, title, type) {
			var f = s.option(form.Value, name, title);
			f.rmempty = true;
			f.validate = required;
			if (type) f.datatype = type;
			return f;
		}
		text('host', '服务器地址', 'host');
		text('port', 'TLS 端口', 'port');
		text('client_id', '客户端 ID').validate = function(section, value) {
			if (!value) return required(section, value);
			return /^[A-Za-z0-9_.-]{1,128}$/.test(value) || '使用 1–128 位字母、数字、点、横线或下划线';
		};
		text('username', '用户名');
		o = text('password', '密码');
		o.password = true;
		o.description = '保存在路由器本机受限配置文件中，不写入插件安装包。';
		o = text('prefix', '主题前缀');
		o.description = '实际主题为：前缀/主机名/插件实例/指标。需给此主题范围配置 EMQX 发布权限。';
		o.validate = function(section, value) {
			if (!value) return required(section, value);
			return /^[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/.test(value) || '仅允许字母、数字、横线、下划线、点和层级分隔符；不含通配符';
		};
		o = s.option(form.ListValue, 'qos', 'QoS');
		o.value('0', '0：最多一次'); o.value('1', '1：至少一次'); o.value('2', '2：恰好一次');
		o.default = '1'; o.rmempty = false;
		[['retain', '保留最新消息', '0'], ['store_rates', '将计数器转换为速率', '1']].forEach(function(f) {
			var flag = s.option(form.Flag, f[0], f[1]);
			flag.default = f[2]; flag.rmempty = false;
		});
		text('ca_cert', 'CA 证书文件', 'file').description = '始终启用 TLS 及证书校验。通常使用系统 CA 文件。';
		o = s.option(form.ListValue, 'tls_protocol', 'TLS 版本');
		o.value('tlsv1.2', 'TLS 1.2'); o.value('tlsv1.3', 'TLS 1.3');
		o.default = 'tlsv1.2'; o.rmempty = false;
		return m.render();
	}
});
