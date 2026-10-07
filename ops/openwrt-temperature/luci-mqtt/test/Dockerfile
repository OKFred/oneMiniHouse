FROM openwrt/rootfs:x86-64-23.05.2
RUN mkdir -p /var/lock && opkg update && opkg install luci-base luci-app-statistics collectd-mod-mqtt ca-bundle
COPY files/ /fixture/files/
COPY test/runtime.sh /fixture/runtime.sh
RUN find /fixture -type f -exec sed -i 's/\r$//' '{}' ';'
ENTRYPOINT ["/bin/sh", "/fixture/runtime.sh"]
