#include <linux/capability.h>
#include <linux/file.h>
#include <linux/fs.h>
#include <linux/miscdevice.h>
#include <linux/module.h>
#include <linux/net.h>
#include <net/af_unix.h>
#include <net/tcp_states.h>

#define PI_SOCKET_DENTRY _IO('P', 0x71)

static long export_dentry(struct file *device, unsigned int command,
                          unsigned long descriptor)
{
    struct file *source, *result;
    struct socket *socket;
    struct path path;
    int target;

    if (command != PI_SOCKET_DENTRY || descriptor > INT_MAX)
        return -EINVAL;
    if (!capable(CAP_SYS_ADMIN))
        return -EPERM;
    source = fget(descriptor);
    if (!source)
        return -EBADF;
    socket = sock_from_file(source);
    if (!socket || !socket->sk || socket->sk->sk_family != AF_UNIX ||
        socket->type != SOCK_STREAM || socket->sk->sk_state != TCP_LISTEN) {
        fput(source);
        return -ENOTSOCK;
    }
    unix_state_lock(socket->sk);
    path = unix_sk(socket->sk)->path;
    if (!path.dentry || !path.mnt) {
        unix_state_unlock(socket->sk);
        fput(source);
        return -ENOENT;
    }
    path_get(&path);
    unix_state_unlock(socket->sk);
    if (!d_inode(path.dentry) || !S_ISSOCK(d_inode(path.dentry)->i_mode)) {
        path_put(&path);
        fput(source);
        return -ENOTSOCK;
    }
    result = dentry_open(&path, O_PATH | O_CLOEXEC, current_cred());
    path_put(&path);
    fput(source);
    if (IS_ERR(result))
        return PTR_ERR(result);
    target = get_unused_fd_flags(O_CLOEXEC);
    if (target < 0) {
        fput(result);
        return target;
    }
    fd_install(target, result);
    return target;
}

static const struct file_operations operations = {
    .owner = THIS_MODULE,
    .unlocked_ioctl = export_dentry,
};

static struct miscdevice endpoint = {
    .minor = MISC_DYNAMIC_MINOR,
    .name = "pi-stack-unix-dentry",
    .fops = &operations,
    .mode = 0600,
};

static int __init start(void) { return misc_register(&endpoint); }
static void __exit stop(void) { misc_deregister(&endpoint); }
module_init(start);
module_exit(stop);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("Finite root-only O_PATH export of an already-owned Unix listener dentry");
