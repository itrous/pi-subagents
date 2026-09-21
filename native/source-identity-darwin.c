/*
 * Darwin tree verifier for src/extension/source-identity-darwin.ts.
 *
 * Input: the package root directory on fd 3 and a closed request on stdin:
 *   "PISIDQ01" | u32 deadline_ms | u32 entry_count | u64 content_limit |
 *   entry_count * (u8 executable | 20-byte Git blob SHA1 | u32 path_len | path)
 * (little-endian integers, raw path bytes relative to the root).
 * Output: "PISIDR01" followed by one result byte, exit status 0. Any other exit
 * means no verdict. Every open is descriptor-relative (openat/fstatat with
 * O_NOFOLLOW/AT_SYMLINK_NOFOLLOW) from the inherited root descriptor.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <CommonCrypto/CommonDigest.h>

#pragma clang diagnostic ignored "-Wdeprecated-declarations"

enum { RESULT_OK = 0, RESULT_DIRTY = 1, RESULT_TOO_LARGE = 2, RESULT_TIMEOUT = 3, RESULT_MALFORMED = 4 };

#define ROOT_FD 3
#define ENTRY_LIMIT 20000u
#define PATH_LIMIT (4u * 1024u * 1024u)
#define COMPONENT_LIMIT 100000u
#define DEPTH_LIMIT 64u
#define CONTENT_LIMIT (64ull * 1024ull * 1024ull)
#define DEADLINE_LIMIT_MS 2000u
#define HEADER_BYTES 24u
#define ENTRY_HEADER_BYTES 25u
#define REQUEST_LIMIT ((size_t)HEADER_BYTES + (size_t)ENTRY_LIMIT * ENTRY_HEADER_BYTES + PATH_LIMIT)
#define READ_CHUNK 65536u

struct node_id { dev_t dev; ino_t ino; mode_t type; };
struct entry {
	const unsigned char *path;
	uint32_t path_len;
	int executable;
	const unsigned char *blob;
	uint32_t first_component;
	uint32_t component_count;
	struct stat final_stat;
};

static uint64_t deadline_ns;
static unsigned char *request;
static size_t request_len;
static struct entry *entries;
static uint32_t entry_count;
static struct node_id *directory_ids;
static uint32_t component_total;
/* Offsets (into the owning path) and lengths of every path component. */
static uint32_t *component_offsets;
static uint32_t *component_lengths;

static uint64_t now_ns(void) { return clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW); }
static int expired(void) { return now_ns() >= deadline_ns; }

static void respond(unsigned char code) {
	unsigned char out[9] = { 'P', 'I', 'S', 'I', 'D', 'R', '0', '1', code };
	size_t done = 0;
	while (done < sizeof out) {
		ssize_t n = write(STDOUT_FILENO, out + done, sizeof out - done);
		if (n < 0 && errno == EINTR) continue;
		if (n <= 0) _exit(3);
		done += (size_t)n;
	}
	_exit(0);
}

static uint32_t le32(const unsigned char *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static uint64_t le64(const unsigned char *p) { return (uint64_t)le32(p) | (uint64_t)le32(p + 4) << 32; }

static int same_node(const struct stat *a, const struct stat *b) {
	return a->st_dev == b->st_dev && a->st_ino == b->st_ino && (a->st_mode & S_IFMT) == (b->st_mode & S_IFMT);
}
static int same_stat(const struct stat *a, const struct stat *b) {
	return same_node(a, b) && a->st_mode == b->st_mode && a->st_size == b->st_size
		&& a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec
		&& a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
}

/* The component is copied into a NUL-terminated buffer; lengths are bounded by PATH_LIMIT. */
static char *component_name(const struct entry *e, uint32_t index, char *buffer) {
	uint32_t slot = e->first_component + index;
	memcpy(buffer, e->path + component_offsets[slot], component_lengths[slot]);
	buffer[component_lengths[slot]] = '\0';
	return buffer;
}

static void read_request(void) {
	size_t capacity = 65536;
	request = malloc(capacity);
	if (!request) _exit(4);
	for (;;) {
		if (request_len == capacity) {
			if (capacity > REQUEST_LIMIT) respond(RESULT_MALFORMED);
			capacity *= 2;
			unsigned char *grown = realloc(request, capacity);
			if (!grown) _exit(4);
			request = grown;
		}
		ssize_t n = read(STDIN_FILENO, request + request_len, capacity - request_len);
		if (n < 0 && errno == EINTR) continue;
		if (n < 0) _exit(4);
		if (n == 0) break;
		request_len += (size_t)n;
		if (request_len > REQUEST_LIMIT) respond(RESULT_MALFORMED);
	}
}

static int valid_component(const unsigned char *p, uint32_t len) {
	if (len == 0 || (len == 1 && p[0] == '.') || (len == 2 && p[0] == '.' && p[1] == '.')) return 0;
	for (uint32_t i = 0; i < len; i += 1) if (p[i] == 0 || p[i] == '/') return 0;
	return 1;
}

static uint64_t parse_request(void) {
	if (request_len < HEADER_BYTES || memcmp(request, "PISIDQ01", 8) != 0) respond(RESULT_MALFORMED);
	uint32_t deadline_ms = le32(request + 8);
	entry_count = le32(request + 12);
	uint64_t content_limit = le64(request + 16);
	if (deadline_ms == 0 || deadline_ms > DEADLINE_LIMIT_MS || entry_count > ENTRY_LIMIT || content_limit > CONTENT_LIMIT) respond(RESULT_MALFORMED);
	deadline_ns = now_ns() + (uint64_t)deadline_ms * 1000000ull;
	entries = calloc(entry_count ? entry_count : 1, sizeof *entries);
	component_offsets = calloc(COMPONENT_LIMIT, sizeof *component_offsets);
	component_lengths = calloc(COMPONENT_LIMIT, sizeof *component_lengths);
	directory_ids = calloc(COMPONENT_LIMIT, sizeof *directory_ids);
	if (!entries || !component_offsets || !component_lengths || !directory_ids) _exit(4);
	size_t offset = HEADER_BYTES;
	uint64_t path_total = 0;
	for (uint32_t i = 0; i < entry_count; i += 1) {
		if (request_len - offset < ENTRY_HEADER_BYTES) respond(RESULT_MALFORMED);
		struct entry *e = &entries[i];
		unsigned char flag = request[offset];
		if (flag > 1) respond(RESULT_MALFORMED);
		e->executable = flag;
		e->blob = request + offset + 1;
		e->path_len = le32(request + offset + 21);
		offset += ENTRY_HEADER_BYTES;
		path_total += e->path_len;
		if (e->path_len == 0 || path_total > PATH_LIMIT || request_len - offset < e->path_len) respond(RESULT_MALFORMED);
		e->path = request + offset;
		offset += e->path_len;
		e->first_component = component_total;
		uint32_t start = 0;
		for (uint32_t k = 0; k <= e->path_len; k += 1) {
			if (k < e->path_len && e->path[k] != '/') continue;
			if (component_total >= COMPONENT_LIMIT || e->component_count >= DEPTH_LIMIT || !valid_component(e->path + start, k - start)) respond(RESULT_MALFORMED);
			component_offsets[component_total] = start;
			component_lengths[component_total] = k - start;
			component_total += 1;
			e->component_count += 1;
			start = k + 1;
		}
	}
	if (offset != request_len) respond(RESULT_MALFORMED);
	return content_limit;
}

static int open_directory(int parent, const char *name) {
	return openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
}

/* Reopens the directory chain from the root and compares every binding with the held one. */
static unsigned char verify_namespace(const struct entry *e, char *name) {
	int opened[DEPTH_LIMIT];
	uint32_t count = 0;
	int parent = ROOT_FD;
	unsigned char result = RESULT_OK;
	for (uint32_t i = 0; i + 1 < e->component_count; i += 1) {
		if (expired()) { result = RESULT_TIMEOUT; goto done; }
		int fd = open_directory(parent, component_name(e, i, name));
		struct stat st;
		if (fd < 0) { result = RESULT_DIRTY; goto done; }
		opened[count++] = fd;
		const struct node_id *held = &directory_ids[e->first_component + i];
		if (fstat(fd, &st) != 0 || st.st_dev != held->dev || st.st_ino != held->ino || (st.st_mode & S_IFMT) != held->type) { result = RESULT_DIRTY; goto done; }
		parent = fd;
	}
	struct stat fresh;
	if (fstatat(parent, component_name(e, e->component_count - 1, name), &fresh, AT_SYMLINK_NOFOLLOW) != 0 || !same_stat(&fresh, &e->final_stat)) result = RESULT_DIRTY;
done:
	while (count > 0) close(opened[--count]);
	if (result == RESULT_DIRTY && expired()) result = RESULT_TIMEOUT;
	return result;
}

static unsigned char verify_entry(struct entry *e, uint64_t *content_used, uint64_t content_limit, char *name, unsigned char *chunk) {
	int opened[DEPTH_LIMIT];
	uint32_t count = 0;
	int parent = ROOT_FD, fd = -1;
	unsigned char result = RESULT_OK;
	for (uint32_t i = 0; i + 1 < e->component_count; i += 1) {
		if (expired()) { result = RESULT_TIMEOUT; goto done; }
		int dir = open_directory(parent, component_name(e, i, name));
		struct stat st;
		if (dir < 0) { result = RESULT_DIRTY; goto done; }
		opened[count++] = dir;
		if (fstat(dir, &st) != 0) { result = RESULT_DIRTY; goto done; }
		directory_ids[e->first_component + i] = (struct node_id){ st.st_dev, st.st_ino, st.st_mode & S_IFMT };
		parent = dir;
	}
	fd = openat(parent, component_name(e, e->component_count - 1, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
	if (fd < 0) { result = RESULT_DIRTY; goto done; }
	struct stat before, after;
	if (fstat(fd, &before) != 0 || !S_ISREG(before.st_mode) || ((before.st_mode & S_IXUSR) != 0) != (e->executable != 0)) { result = RESULT_DIRTY; goto done; }
	if (before.st_size < 0 || (uint64_t)before.st_size > content_limit - *content_used) { result = RESULT_TOO_LARGE; goto done; }
	/* Never trust the declared size: read at most size+1 bytes and hash exactly what was read. */
	uint64_t expected = (uint64_t)before.st_size, total = 0;
	CC_SHA1_CTX sha;
	CC_SHA1_Init(&sha);
	char header[32];
	int header_len = snprintf(header, sizeof header, "blob %llu", (unsigned long long)expected);
	CC_SHA1_Update(&sha, header, (CC_LONG)header_len + 1);
	for (;;) {
		if (expired()) { result = RESULT_TIMEOUT; goto done; }
		uint64_t want = expected + 1 - total;
		ssize_t n = read(fd, chunk, want < READ_CHUNK ? (size_t)want : READ_CHUNK);
		if (n < 0 && errno == EINTR) continue;
		if (n < 0) { result = RESULT_DIRTY; goto done; }
		if (n == 0) break;
		total += (uint64_t)n;
		if (total > expected) { result = RESULT_DIRTY; goto done; }
		CC_SHA1_Update(&sha, chunk, (CC_LONG)n);
	}
	unsigned char digest[CC_SHA1_DIGEST_LENGTH];
	CC_SHA1_Final(digest, &sha);
	if (total != expected || fstat(fd, &after) != 0 || !same_stat(&before, &after)) { result = RESULT_DIRTY; goto done; }
	*content_used += total;
	if (memcmp(digest, e->blob, CC_SHA1_DIGEST_LENGTH) != 0) { result = RESULT_DIRTY; goto done; }
	e->final_stat = before;
done:
	if (fd >= 0) close(fd);
	while (count > 0) close(opened[--count]);
	if (result == RESULT_DIRTY && expired()) result = RESULT_TIMEOUT;
	if (result != RESULT_OK) return result;
	if (expired()) return RESULT_TIMEOUT;
	return verify_namespace(e, name);
}

int main(void) {
	struct stat root;
	if (fstat(ROOT_FD, &root) != 0 || !S_ISDIR(root.st_mode)) return 2;
	read_request();
	uint64_t content_limit = parse_request();
	char *name = malloc(PATH_LIMIT + 1);
	unsigned char *chunk = malloc(READ_CHUNK);
	if (!name || !chunk) return 4;
	uint64_t content_used = 0;
	for (uint32_t i = 0; i < entry_count; i += 1) {
		unsigned char result = verify_entry(&entries[i], &content_used, content_limit, name, chunk);
		if (result != RESULT_OK) respond(result);
	}
	/* A later entry may race and mutate one already verified: recheck every binding. */
	for (uint32_t i = 0; i < entry_count; i += 1) {
		if (expired()) respond(RESULT_TIMEOUT);
		unsigned char result = verify_namespace(&entries[i], name);
		if (result != RESULT_OK) respond(result);
	}
	respond(RESULT_OK);
}
