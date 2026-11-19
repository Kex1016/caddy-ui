# Updater sidecar: docker CLI + compose plugin + the shell scripts. No UI code inside.
FROM docker:27-cli
RUN apk add --no-cache bash socat openssl git util-linux jq
COPY updater.sh webhook-handler.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/updater.sh /usr/local/bin/webhook-handler.sh
ENTRYPOINT ["/usr/local/bin/updater.sh"]
CMD ["loop"]
